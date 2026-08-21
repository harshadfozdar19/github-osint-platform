import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  IntentAssessment,
  IntentAssessmentDocument,
  RepositoryIntent,
} from './schemas/intent-assessment.schema';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import { severityFromScore } from '../common/enums';
import { IntentContextBuilder } from './intent-context.builder';
import { GeminiIntentProvider } from './providers/gemini-intent.provider';
import { OpenRouterIntentProvider } from './providers/openrouter-intent.provider';
import {
  IntentProvider,
  IntentProviderError,
} from './providers/intent-provider.interface';
import { PROMPT_VERSION } from './intent-prompt';

/**
 * Orchestrates one repository's intent assessment: build context -> call
 * the configured provider(s) in priority order, falling back to the next
 * one on failure -> persist the result (or the failure itself, so a broken
 * provider is visible rather than silently dropped). Fails closed at every
 * step - an LLM outage or a misconfigured key must never break the scan
 * pipeline that enqueues this, matching ScanPipelineService.checkLiveness's
 * own philosophy for the exact same reason.
 *
 * On a successful assessment, the assessed Finding's own riskScore/severity
 * are OVERWRITTEN with the AI's numbers (see Finding.scoringSource) - the
 * deterministic rule engine still runs and still produces the evidence the
 * AI reasons over (riskBreakdown stays as a historical record of how the
 * original number was computed), but the two scores must never both be "the"
 * current score for the same finding, so the AI's number takes over
 * everywhere that finding's score is read (list, dashboard, sorting,
 * filtering) the moment it succeeds, not just in a separate advisory panel.
 * A failed assessment leaves the rule score untouched - there's no reliable
 * AI number to replace it with.
 */
@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    @InjectModel(IntentAssessment.name)
    private readonly assessmentModel: Model<IntentAssessmentDocument>,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    private readonly contextBuilder: IntentContextBuilder,
    private readonly gemini: GeminiIntentProvider,
    private readonly openrouter: OpenRouterIntentProvider,
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

    let lastError: unknown;
    for (const provider of chain) {
      try {
        const result = await provider.assess(context);
        const assessment = await this.assessmentModel.create({
          workspaceId: new Types.ObjectId(workspaceId),
          repositoryId: new Types.ObjectId(repositoryId),
          findingId: findingId ? new Types.ObjectId(findingId) : undefined,
          intent: result.intent as RepositoryIntent,
          riskScore: result.riskScore,
          confidence: result.confidence,
          reasoning: result.reasoning,
          signalsUsed: result.signalsUsed,
          provider: provider.name,
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
              },
            },
          );
        }
        return assessment;
      } catch (error) {
        lastError = error;
        const message =
          error instanceof IntentProviderError ? error.message : String(error);
        this.logger.warn(
          `Intent provider "${provider.name}" failed for repository ${repositoryId}: ${message}`,
        );
      }
    }

    // Every configured provider failed - record the failure so it's visible
    // (rather than a silent gap in coverage) instead of throwing back into
    // the scan pipeline.
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    return this.assessmentModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      repositoryId: new Types.ObjectId(repositoryId),
      findingId: findingId ? new Types.ObjectId(findingId) : undefined,
      intent: RepositoryIntent.INCONCLUSIVE,
      riskScore: 0,
      confidence: 0,
      reasoning: 'Assessment failed - every configured provider errored.',
      signalsUsed: [],
      provider: chain[chain.length - 1].name,
      model: 'n/a',
      promptVersion: PROMPT_VERSION,
      status: 'failed',
      error: message.slice(0, 2000),
    });
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
}
