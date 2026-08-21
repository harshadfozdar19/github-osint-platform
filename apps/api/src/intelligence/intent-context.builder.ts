import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import {
  Detection,
  DetectionDocument,
} from '../detections/schemas/detection.schema';
import {
  OperatorFingerprint,
  OperatorFingerprintDocument,
} from '../detection/schemas/operator-fingerprint.schema';
import {
  RepositoryContributor,
  RepositoryContributorDocument,
} from '../repositories/schemas/repository-contributor.schema';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../brands/schemas/monitored-brand.schema';
import { FindingStatus } from '../common/enums';
import { IntentContext } from './providers/intent-provider.interface';

/**
 * Assembles the compact, structured context an intent-assessment call is
 * grounded in - deliberately built from what the deterministic rule engine
 * and the platform's other existing signals (operator/identity, credential
 * verification, trust) already extracted, never raw file dumps. Keeps
 * token cost low and signal density high, and means the LLM is reasoning
 * over the same evidence an analyst would see on the Finding detail page,
 * not re-deriving it from scratch.
 *
 * The operator/cross-identity queries below deliberately mirror (rather
 * than import) ScanPipelineService.getOperatorContext/getCrossIdentityContext
 * (apps/api/src/scans/scan-pipeline.service.ts) - small enough to duplicate
 * directly against this builder's own injected models, avoiding a new
 * cross-module dependency from IntelligenceModule into ScansModule inside
 * the queue-processing hot path.
 */
@Injectable()
export class IntentContextBuilder {
  constructor(
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Detection.name)
    private readonly detectionModel: Model<DetectionDocument>,
    @InjectModel(OperatorFingerprint.name)
    private readonly fingerprintModel: Model<OperatorFingerprintDocument>,
    @InjectModel(RepositoryContributor.name)
    private readonly contributorModel: Model<RepositoryContributorDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
  ) {}

  async build(
    workspaceId: string,
    repositoryId: string,
    findingId?: string,
  ): Promise<IntentContext | null> {
    const ws = new Types.ObjectId(workspaceId);
    const repoOid = new Types.ObjectId(repositoryId);

    const repo = await this.repoModel
      .findOne({ _id: repoOid, workspaceId: ws })
      .lean()
      .exec();
    if (!repo) return null;

    const finding = findingId
      ? await this.findingModel
          .findOne({ _id: new Types.ObjectId(findingId), workspaceId: ws })
          .lean()
          .exec()
      : await this.findingModel
          .findOne({ repositoryId: repoOid, workspaceId: ws })
          .sort({ riskScore: -1 })
          .lean()
          .exec();
    if (!finding) return null;

    const [
      detections,
      otherReposByOwnerInWorkspace,
      operatorSignals,
      contributors,
      trustSignals,
    ] = await Promise.all([
      this.detectionModel
        .find({ workspaceId: ws, findingId: finding._id })
        .select(
          'ruleId category severity confidence evidence explanation verification',
        )
        .lean()
        .exec(),
      this.repoModel
        .countDocuments({
          workspaceId: ws,
          owner: repo.owner,
          _id: { $ne: repo._id },
        })
        .exec(),
      this.getOperatorSignals(ws, repo._id, repo.owner),
      this.getContributorSignals(ws, repo._id),
      this.getTrustSignals(ws, finding.brandId, repo.owner),
    ]);

    return {
      repository: {
        fullName: repo.fullName,
        owner: repo.owner,
        description: repo.description || '',
        topics: repo.topics || [],
        language: repo.language || '',
        stars: repo.stars || 0,
        forks: repo.forks || 0,
        isFork: repo.isFork || false,
        githubCreatedAt: repo.githubCreatedAt?.toISOString(),
        githubPushedAt: repo.githubPushedAt?.toISOString(),
        otherReposByOwnerInWorkspace,
      },
      brand: finding.brandName
        ? {
            name: finding.brandName,
            matchType: finding.brandMatchEvidence?.type,
            matchLocation: finding.brandMatchEvidence?.location,
            matchedAlias: finding.brandMatchEvidence?.matchedAlias,
            matchedText: finding.brandMatchEvidence?.matchedText,
          }
        : undefined,
      deployment: repo.deployment
        ? {
            url: repo.deployment.url,
            state: repo.deployment.state,
            confirmedLive: detections.some(
              (d) => d.ruleId === 'confirmed-live-deployment',
            ),
          }
        : undefined,
      finding: {
        severity: finding.severity,
        riskScore: finding.riskScore,
        categories: finding.categories || [],
        origin: finding.origin,
      },
      detections: detections.map((d) => ({
        ruleId: d.ruleId,
        category: d.category,
        severity: d.severity,
        confidence: d.confidence,
        evidence: d.evidence,
        explanation: d.explanation,
      })),
      operatorSignals,
      contributors,
      credentials: detections
        .filter((d) => d.verification)
        .map((d) => ({
          type: d.ruleId,
          verificationStatus: d.verification!.status,
        })),
      trustSignals,
    };
  }

  /**
   * Mirrors ScanPipelineService.getOperatorContext (same-owner repeat
   * operator) and getCrossIdentityContext (shared contact/wallet
   * fingerprint under a different owner), but reads this repo's own
   * already-persisted OperatorFingerprint rows instead of a freshly
   * extracted list, since those rows already exist by the time an intent
   * assessment runs.
   */
  private async getOperatorSignals(
    workspaceId: Types.ObjectId,
    repositoryId: Types.ObjectId,
    owner: string,
  ): Promise<IntentContext['operatorSignals']> {
    const otherRepos = await this.repoModel
      .find({ workspaceId, owner, _id: { $ne: repositoryId } })
      .select('_id')
      .lean()
      .exec();
    let otherBrandsHit = 0;
    if (otherRepos.length > 0) {
      const otherFindings = await this.findingModel
        .find({
          workspaceId,
          repositoryId: { $in: otherRepos.map((r) => r._id) },
          status: { $ne: FindingStatus.FALSE_POSITIVE },
        })
        .select('brandName')
        .lean()
        .exec();
      otherBrandsHit = new Set(
        otherFindings.map((f) => f.brandName).filter(Boolean),
      ).size;
    }

    const ownFingerprints = await this.fingerprintModel
      .find({ workspaceId, repositoryId })
      .select('kind value')
      .lean()
      .exec();
    let linkedIdentityOwners = 0;
    if (ownFingerprints.length > 0) {
      const matches = await this.fingerprintModel
        .find({
          workspaceId,
          owner: { $ne: owner },
          $or: ownFingerprints.map((f) => ({ kind: f.kind, value: f.value })),
        })
        .select('owner repositoryId')
        .lean()
        .exec();
      if (matches.length > 0) {
        const repoIds = [
          ...new Set(matches.map((m) => String(m.repositoryId))),
        ].map((id) => new Types.ObjectId(id));
        const activeFindings = await this.findingModel
          .find({
            workspaceId,
            repositoryId: { $in: repoIds },
            status: { $ne: FindingStatus.FALSE_POSITIVE },
          })
          .select('repositoryId')
          .lean()
          .exec();
        const activeRepoIds = new Set(
          activeFindings.map((f) => String(f.repositoryId)),
        );
        linkedIdentityOwners = new Set(
          matches
            .filter((m) => activeRepoIds.has(String(m.repositoryId)))
            .map((m) => m.owner),
        ).size;
      }
    }

    return { otherBrandsHit, linkedIdentityOwners };
  }

  private async getContributorSignals(
    workspaceId: Types.ObjectId,
    repositoryId: Types.ObjectId,
  ): Promise<IntentContext['contributors']> {
    const own = await this.contributorModel
      .find({ workspaceId, repositoryId })
      .select('login')
      .lean()
      .exec();
    if (own.length === 0) return { count: 0, overlapWithOtherRepos: 0 };

    const overlap = await this.contributorModel
      .find({
        workspaceId,
        repositoryId: { $ne: repositoryId },
        login: { $in: own.map((c) => c.login) },
      })
      .distinct('login')
      .exec();

    return { count: own.length, overlapWithOtherRepos: overlap.length };
  }

  private async getTrustSignals(
    workspaceId: Types.ObjectId,
    brandId: Types.ObjectId | undefined,
    owner: string,
  ): Promise<IntentContext['trustSignals']> {
    if (!brandId) return { isTrustedOwner: false };
    const brand = await this.brandModel
      .findOne({ _id: brandId, workspaceId })
      .select('trustedGithubOwners')
      .lean()
      .exec();
    const isTrustedOwner = !!brand?.trustedGithubOwners?.some(
      (o) => o.toLowerCase() === owner.toLowerCase(),
    );
    return { isTrustedOwner };
  }
}
