import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import {
  IntentAssessment,
  IntentAssessmentDocument,
  RepositoryIntent,
} from './schemas/intent-assessment.schema';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import {
  Detection,
  DetectionDocument,
} from '../detections/schemas/detection.schema';
import { severityFromScore } from '../common/enums';
import { IntentContextBuilder } from './intent-context.builder';
import { DeepIntentContextBuilder } from './deep-intent-context.builder';
import { GeminiIntentProvider } from './providers/gemini-intent.provider';
import { OpenRouterIntentProvider } from './providers/openrouter-intent.provider';
import {
  DeepIntentContext,
  IntentContext,
  IntentProvider,
  IntentProviderError,
  IntentResult,
} from './providers/intent-provider.interface';
import { validateCitations } from './providers/validate-citations';
import { computeContextHash } from './context-hash';
import { PROMPT_VERSION, buildDeepUserPrompt } from './intent-prompt';

interface ChainSuccess {
  ok: true;
  provider: string;
  result: IntentResult;
  strippedCitations: number;
}
interface ChainFailure {
  ok: false;
  lastProvider: string;
  error: string;
}

/**
 * Orchestrates one repository's intent assessment: build context -> check
 * idempotency (skip the LLM entirely if nothing relevant changed since the
 * last completed assessment) -> call the configured provider(s) in
 * priority order, falling back to the next one on failure -> validate any
 * evidence citations against what was actually supplied -> persist the
 * result (or the failure itself, so a broken provider is visible rather
 * than silently dropped) -> if the Tier-1 verdict was uncertain, run a
 * bounded Tier-2 "deep review" with extra repository content. Fails closed
 * at every step - an LLM outage or a misconfigured key must never break the
 * scan pipeline that enqueues this, matching ScanPipelineService.
 * checkLiveness's own philosophy for the exact same reason.
 *
 * On a successful assessment (either tier), the assessed Finding's own
 * riskScore/severity are OVERWRITTEN with the AI's numbers (see
 * Finding.scoringSource) - the deterministic rule engine still runs and
 * still produces the evidence the AI reasons over (riskBreakdown stays as a
 * historical record of how the original number was computed), but the two
 * scores must never both be "the" current score for the same finding, so
 * the AI's number takes over everywhere that finding's score is read
 * (list, dashboard, sorting, filtering) the moment it succeeds. A failed
 * assessment, or a Tier-2 pass that itself fails, leaves the previously
 * persisted score untouched - there's no reliable AI number to replace it
 * with.
 */
@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    @InjectModel(IntentAssessment.name)
    private readonly assessmentModel: Model<IntentAssessmentDocument>,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Detection.name)
    private readonly detectionModel: Model<DetectionDocument>,
    private readonly contextBuilder: IntentContextBuilder,
    private readonly deepContextBuilder: DeepIntentContextBuilder,
    private readonly gemini: GeminiIntentProvider,
    private readonly openrouter: OpenRouterIntentProvider,
    private readonly config: ConfigService,
  ) {}

  /** Priority order: Gemini (free tier) first, OpenRouter as the fallback when Gemini is unconfigured or erroring. */
  private providerChain(): IntentProvider[] {
    const chain: IntentProvider[] = [];
    if (this.gemini.isConfigured()) chain.push(this.gemini);
    if (this.openrouter.isConfigured()) chain.push(this.openrouter);
    return chain;
  }

  async assess(
    workspaceId: string,
    repositoryId: string,
    findingId?: string,
  ): Promise<IntentAssessmentDocument | null> {
    const chain = this.providerChain();
    if (chain.length === 0) {
      this.logger.warn(
        'No intent-assessment provider configured (GEMINI_API_KEY / OPENROUTER_API_KEY both unset) - skipping.',
      );
      return null;
    }

    const context = await this.contextBuilder.build(
      workspaceId,
      repositoryId,
      findingId,
    );
    if (!context) {
      this.logger.warn(
        `Intent assessment skipped for repository ${repositoryId} - repository or finding not found.`,
      );
      return null;
    }

    const contextHash = computeContextHash(context, PROMPT_VERSION);

    if (findingId) {
      const existing = await this.assessmentModel
        .findOne({
          findingId: new Types.ObjectId(findingId),
          contextHash,
          status: 'completed',
        })
        .sort({ createdAt: -1 })
        .exec();
      if (existing) {
        this.logger.log(
          `Intent assessment reused via idempotency for finding ${findingId} (contextHash=${contextHash.slice(0, 12)}…)`,
        );
        return existing;
      }
    }

    const tier1 = await this.runTier(
      chain,
      context,
      workspaceId,
      repositoryId,
      findingId,
      contextHash,
      'first',
    );
    if (!tier1) return null;

    if (
      tier1.status === 'completed' &&
      this.shouldDeepReview(
        tier1.intent,
        tier1.confidence,
        tier1.needsDeepReview,
      )
    ) {
      const deep = await this.runDeepReview(
        chain,
        context,
        workspaceId,
        repositoryId,
        findingId,
        contextHash,
      );
      if (deep) return deep;
    }

    return tier1;
  }

  private shouldDeepReview(
    intent: RepositoryIntent,
    confidence: number,
    needsDeepReviewFlag = false,
  ): boolean {
    const threshold = Number(
      this.config.get('INTELLIGENCE_DEEP_REVIEW_CONFIDENCE_THRESHOLD') || 0.5,
    );
    return (
      needsDeepReviewFlag ||
      intent === RepositoryIntent.INCONCLUSIVE ||
      confidence < threshold
    );
  }

  private async attemptChain(
    chain: IntentProvider[],
    context: IntentContext,
    options?: {
      userPrompt?: string;
      modelOverrides?: Record<string, string | undefined>;
    },
    deepContext?: DeepIntentContext,
  ): Promise<ChainSuccess | ChainFailure> {
    let lastError: unknown;
    let lastProviderName = chain[chain.length - 1]?.name ?? 'none';
    for (const provider of chain) {
      try {
        const raw = await provider.assess(context, {
          userPrompt: options?.userPrompt,
          modelOverride: options?.modelOverrides?.[provider.name],
        });
        const { result: validated, strippedCount } = validateCitations(
          raw,
          context,
          deepContext,
        );
        return {
          ok: true,
          provider: provider.name,
          result: { ...validated, model: raw.model },
          strippedCitations: strippedCount,
        };
      } catch (error) {
        lastError = error;
        lastProviderName = provider.name;
        const message =
          error instanceof IntentProviderError ? error.message : String(error);
        this.logger.warn(
          `Intent provider "${provider.name}" failed: ${message}`,
        );
      }
    }
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    return {
      ok: false,
      lastProvider: lastProviderName,
      error: message.slice(0, 2000),
    };
  }

  private async runTier(
    chain: IntentProvider[],
    context: IntentContext,
    workspaceId: string,
    repositoryId: string,
    findingId: string | undefined,
    contextHash: string,
    tier: 'first' | 'deep',
  ): Promise<IntentAssessmentDocument | null> {
    const outcome = await this.attemptChain(chain, context);

    if (outcome.ok) {
      if (outcome.strippedCitations > 0) {
        this.logger.warn(
          `Stripped ${outcome.strippedCitations} unsupported evidence citation(s) from ${outcome.provider}'s ${tier}-tier response for repository ${repositoryId} - confidence downgraded.`,
        );
      }
      return this.persistCompleted({
        workspaceId,
        repositoryId,
        findingId,
        tier,
        contextHash,
        provider: outcome.provider,
        result: outcome.result,
      });
    }

    // Every configured provider failed - record the failure so it's visible
    // (rather than a silent gap in coverage) instead of throwing back into
    // the scan pipeline. Tier-2 failures never touch the Finding - Tier 1's
    // already-persisted result stands.
    return this.assessmentModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      repositoryId: new Types.ObjectId(repositoryId),
      findingId: findingId ? new Types.ObjectId(findingId) : undefined,
      tier,
      contextHash,
      intent: RepositoryIntent.INCONCLUSIVE,
      riskScore: 0,
      confidence: 0,
      reasoning: 'Assessment failed - every configured provider errored.',
      signalsUsed: [],
      factors: [],
      missingInformation: [],
      needsDeepReview: false,
      provider: outcome.lastProvider,
      model: 'n/a',
      promptVersion: PROMPT_VERSION,
      status: 'failed',
      error: outcome.error,
    });
  }

  private async runDeepReview(
    chain: IntentProvider[],
    context: IntentContext,
    workspaceId: string,
    repositoryId: string,
    findingId: string | undefined,
    contextHash: string,
  ): Promise<IntentAssessmentDocument | null> {
    try {
      const detectionFiles = findingId
        ? (
            await this.detectionModel
              .find({
                workspaceId: new Types.ObjectId(workspaceId),
                findingId: new Types.ObjectId(findingId),
              })
              .select('file')
              .lean()
              .exec()
          ).map((d) => d.file)
        : [];

      const [owner, name] = context.repository.fullName.split('/');
      const deepContext = await this.deepContextBuilder.build(
        workspaceId,
        { owner, name },
        detectionFiles,
      );

      const outcome = await this.attemptChain(
        chain,
        context,
        {
          userPrompt: buildDeepUserPrompt(context, deepContext),
          modelOverrides: {
            gemini: this.config.get<string>('GEMINI_DEEP_MODEL') || undefined,
            openrouter:
              this.config.get<string>('OPENROUTER_DEEP_MODEL') || undefined,
          },
        },
        deepContext,
      );

      if (!outcome.ok) {
        this.logger.warn(
          `Deep review failed for repository ${repositoryId} (${outcome.error}) - keeping the Tier-1 result.`,
        );
        // Persist the failure for visibility, but the caller keeps
        // returning the already-persisted Tier-1 assessment/Finding.
        await this.assessmentModel.create({
          workspaceId: new Types.ObjectId(workspaceId),
          repositoryId: new Types.ObjectId(repositoryId),
          findingId: findingId ? new Types.ObjectId(findingId) : undefined,
          tier: 'deep',
          contextHash,
          intent: RepositoryIntent.INCONCLUSIVE,
          riskScore: 0,
          confidence: 0,
          reasoning: 'Deep review failed - every configured provider errored.',
          signalsUsed: [],
          factors: [],
          missingInformation: [],
          needsDeepReview: false,
          provider: outcome.lastProvider,
          model: 'n/a',
          promptVersion: PROMPT_VERSION,
          status: 'failed',
          error: outcome.error,
        });
        return null;
      }

      if (outcome.strippedCitations > 0) {
        this.logger.warn(
          `Stripped ${outcome.strippedCitations} unsupported evidence citation(s) from ${outcome.provider}'s deep-tier response for repository ${repositoryId} - confidence downgraded.`,
        );
      }

      const assessment = await this.persistCompleted({
        workspaceId,
        repositoryId,
        findingId,
        tier: 'deep',
        contextHash,
        provider: outcome.provider,
        result: outcome.result,
      });
      assessment.deepReviewedAt = new Date();
      await assessment.save();
      return assessment;
    } catch (error) {
      this.logger.warn(
        `Deep review context build failed for repository ${repositoryId}: ${error instanceof Error ? error.message : String(error)} - keeping the Tier-1 result.`,
      );
      return null;
    }
  }

  private async persistCompleted(params: {
    workspaceId: string;
    repositoryId: string;
    findingId?: string;
    tier: 'first' | 'deep';
    contextHash: string;
    provider: string;
    result: IntentResult;
  }): Promise<IntentAssessmentDocument> {
    const {
      workspaceId,
      repositoryId,
      findingId,
      tier,
      contextHash,
      provider,
      result,
    } = params;
    const assessment = await this.assessmentModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      repositoryId: new Types.ObjectId(repositoryId),
      findingId: findingId ? new Types.ObjectId(findingId) : undefined,
      tier,
      contextHash,
      intent: result.intent as RepositoryIntent,
      riskScore: result.riskScore,
      confidence: result.confidence,
      reasoning: result.reasoning,
      signalsUsed: result.signalsUsed,
      factors: result.factors,
      missingInformation: result.missingInformation,
      needsDeepReview: result.needsDeepReview,
      provider,
      model: result.model,
      promptVersion: PROMPT_VERSION,
      status: 'completed',
    });

    if (findingId) {
      await this.findingModel.updateOne(
        {
          _id: new Types.ObjectId(findingId),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        {
          $set: {
            riskScore: result.riskScore,
            severity: severityFromScore(result.riskScore),
            scoringSource: 'ai',
            latestIntent: result.intent,
            needsDeepReview: result.needsDeepReview,
          },
        },
      );
    }

    return assessment;
  }

  /**
   * Re-runs assessment for a repository's most relevant finding on demand
   * (an analyst clicking "request re-analysis"). Safe to call repeatedly:
   * assess()'s own idempotency check makes this a no-op LLM-call-wise if
   * nothing about the finding/repo/prompt has changed since the last
   * completed assessment.
   */
  async reanalyze(
    workspaceId: string,
    repositoryId: string,
  ): Promise<IntentAssessmentDocument | null> {
    const finding = await this.findingModel
      .findOne({
        repositoryId: new Types.ObjectId(repositoryId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .sort({ riskScore: -1 })
      .select('_id')
      .lean()
      .exec();
    if (!finding) return null;
    return this.assess(workspaceId, repositoryId, String(finding._id));
  }

  async latestForRepository(
    workspaceId: string,
    repositoryId: string,
  ): Promise<IntentAssessmentDocument | null> {
    return this.assessmentModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        repositoryId: new Types.ObjectId(repositoryId),
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  async recordAgreement(
    workspaceId: string,
    assessmentId: string,
    agreement: 'agree' | 'disagree',
  ): Promise<IntentAssessmentDocument | null> {
    return this.assessmentModel
      .findOneAndUpdate(
        { _id: assessmentId, workspaceId: new Types.ObjectId(workspaceId) },
        { $set: { analystAgreement: agreement } },
        { new: true },
      )
      .exec();
  }

  /** Cheap observability: counts by tier/status/provider, straight off the persisted history - no separate metrics store. */
  async stats(workspaceId: string): Promise<
    Array<{
      tier: string;
      status: string;
      provider: string;
      count: number;
    }>
  > {
    const rows = await this.assessmentModel.aggregate<{
      _id: { tier: string; status: string; provider: string };
      count: number;
    }>([
      { $match: { workspaceId: new Types.ObjectId(workspaceId) } },
      {
        $group: {
          _id: { tier: '$tier', status: '$status', provider: '$provider' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);
    return rows.map((r) => ({
      tier: r._id.tier,
      status: r._id.status,
      provider: r._id.provider,
      count: r.count,
    }));
  }
}
