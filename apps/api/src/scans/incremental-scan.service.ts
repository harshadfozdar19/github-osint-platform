import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ScanCheckpointStage, ScanMode } from '../common/enums';
import { DetectionEngine } from '../detection/detection.engine';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import { ScanJob, ScanJobDocument } from './schemas/scan-job.schema';

export type RescanReason =
  | 'force_full'
  | 'failed_only'
  | 'no_prior_success'
  | 'previous_failed'
  | 'ruleset_changed'
  | 'content_changed'
  | 'sha_changed'
  | 'first_seen';

export interface ChangeDecision {
  analyze: boolean;
  reason: RescanReason | 'unchanged';
  commitSha?: string;
  defaultBranch?: string;
}

@Injectable()
export class IncrementalScanService {
  private readonly logger = new Logger(IncrementalScanService.name);

  constructor(
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    private readonly detectionEngine: DetectionEngine,
  ) {}

  currentRulesetVersion(): string {
    return this.detectionEngine.getRulesetVersion();
  }

  async getScan(scanJobId: string) {
    return this.scanModel.findById(scanJobId).exec();
  }

  async saveCheckpoint(
    scanJobId: string,
    patch: Partial<ScanJob['checkpoint']> & { stage?: ScanCheckpointStage },
  ) {
    const scan = await this.scanModel.findById(scanJobId).exec();
    if (!scan) return null;
    const checkpoint = {
      ...(scan.checkpoint || {
        stage: ScanCheckpointStage.QUEUED,
        searchCursors: {},
        completedGithubIds: [],
        skippedGithubIds: [],
        failedGithubIds: [],
        pendingGithubIds: [],
      }),
      ...patch,
      updatedAt: new Date(),
    };
    scan.checkpoint = checkpoint;
    if (patch.stage) scan.checkpoint.stage = patch.stage;
    await scan.save();
    return scan;
  }

  async markGithubCompleted(scanJobId: string, githubId: number) {
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $addToSet: {
        'checkpoint.completedGithubIds': githubId,
      },
      $pull: {
        'checkpoint.pendingGithubIds': githubId,
      },
      $set: {
        'checkpoint.stage': ScanCheckpointStage.ANALYSIS,
        'checkpoint.updatedAt': new Date(),
      },
    });
  }

  async markGithubSkipped(scanJobId: string, githubId: number) {
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $addToSet: {
        'checkpoint.skippedGithubIds': githubId,
        'checkpoint.completedGithubIds': githubId,
      },
      $set: {
        'checkpoint.stage': ScanCheckpointStage.ANALYSIS,
        'checkpoint.updatedAt': new Date(),
      },
    });
  }

  async markGithubFailed(scanJobId: string, githubId: number) {
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $addToSet: { 'checkpoint.failedGithubIds': githubId },
      $pull: { 'checkpoint.pendingGithubIds': githubId },
    });
  }

  async isAlreadyCompleted(
    scanJobId: string,
    githubId: number,
  ): Promise<boolean> {
    const scan = await this.scanModel
      .findById(scanJobId)
      .select('checkpoint')
      .lean()
      .exec();
    return Boolean(scan?.checkpoint?.completedGithubIds?.includes(githubId));
  }

  /** Claim a repository ID for analysis once per scan (race-safe). */
  async claimRepositoryForAnalysis(
    scanJobId: string,
    githubId: number,
    maxRepos: number,
  ): Promise<boolean> {
    const scan = await this.scanModel.findById(scanJobId).lean().exec();
    if (!scan) return false;

    const checkpoint = scan.checkpoint || {
      completedGithubIds: [],
      skippedGithubIds: [],
      failedGithubIds: [],
      pendingGithubIds: [],
    };

    const completed = checkpoint.completedGithubIds || [];
    const skipped = checkpoint.skippedGithubIds || [];
    const failed = checkpoint.failedGithubIds || [];
    const pending = checkpoint.pendingGithubIds || [];

    if (
      completed.includes(githubId) ||
      skipped.includes(githubId) ||
      failed.includes(githubId) ||
      pending.includes(githubId)
    ) {
      return false;
    }

    const totalDiscovered =
      completed.length + skipped.length + failed.length + pending.length;
    if (totalDiscovered >= maxRepos) {
      return false;
    }

    const updated = await this.scanModel
      .findOneAndUpdate(
        {
          _id: scanJobId,
          'checkpoint.completedGithubIds': { $ne: githubId },
          'checkpoint.skippedGithubIds': { $ne: githubId },
          'checkpoint.failedGithubIds': { $ne: githubId },
          'checkpoint.pendingGithubIds': { $ne: githubId },
        },
        {
          $addToSet: { 'checkpoint.pendingGithubIds': githubId },
          $set: { 'checkpoint.updatedAt': new Date() },
        },
        { new: true },
      )
      .lean()
      .exec();

    return Boolean(updated);
  }

  /**
   * Batched equivalent of claimRepositoryForAnalysis for callers that
   * already have the FULL candidate id list upfront (ANALYZE_PENDING,
   * FAILED_ONLY) - one read + one write for the whole batch instead of two
   * Mongo round-trips PER repo. At a few thousand pending repos, the
   * per-item version turns simply *enqueueing* work into the slow part of
   * the scan, before any actual analysis has even started - a large enough
   * backlog can make it look like repos are silently being dropped when
   * really the orchestrator job is just grinding through round-trips one at
   * a time. Safe to batch here (unlike the per-item version) because
   * ANALYZE_PENDING/FAILED_ONLY are each a single orchestrator job claiming
   * for its own scan - nothing else writes this scan's checkpoint arrays
   * concurrently. That's NOT true of GitHubSearchProcessor's per-page
   * claiming, where several search-query jobs for the same scan really can
   * race each other, which is what claimRepositoryForAnalysis's per-item
   * find-then-conditional-update is actually for - this method intentionally
   * doesn't replace it there.
   */
  async claimManyForAnalysis(
    scanJobId: string,
    githubIds: number[],
    maxRepos: number,
  ): Promise<number[]> {
    if (githubIds.length === 0) return [];
    const scan = await this.scanModel.findById(scanJobId).lean().exec();
    if (!scan) return [];

    const checkpoint = scan.checkpoint || {
      completedGithubIds: [],
      skippedGithubIds: [],
      failedGithubIds: [],
      pendingGithubIds: [],
    };
    const already = new Set<number>([
      ...(checkpoint.completedGithubIds || []),
      ...(checkpoint.skippedGithubIds || []),
      ...(checkpoint.failedGithubIds || []),
      ...(checkpoint.pendingGithubIds || []),
    ]);
    const budget = Math.max(0, maxRepos - already.size);

    const claimed: number[] = [];
    for (const githubId of githubIds) {
      if (claimed.length >= budget) break;
      if (already.has(githubId)) continue;
      already.add(githubId);
      claimed.push(githubId);
    }
    if (claimed.length === 0) return [];

    await this.scanModel
      .findByIdAndUpdate(scanJobId, {
        $addToSet: { 'checkpoint.pendingGithubIds': { $each: claimed } },
        $set: { 'checkpoint.updatedAt': new Date() },
      })
      .exec();

    return claimed;
  }

  /** Claim owner fan-out once per scan (race-safe). */
  async claimOwnerExpansion(
    scanJobId: string,
    owner: string,
  ): Promise<boolean> {
    const updated = await this.scanModel
      .findOneAndUpdate(
        {
          _id: scanJobId,
          'checkpoint.expandedOwners': { $nin: [owner] },
        },
        {
          $addToSet: { 'checkpoint.expandedOwners': owner },
          $set: { 'checkpoint.updatedAt': new Date() },
        },
        { new: true },
      )
      .lean()
      .exec();
    return Boolean(updated);
  }

  /** Claim fork-walk once per source githubId in this scan. */
  async claimForkExpansion(
    scanJobId: string,
    githubId: number,
  ): Promise<boolean> {
    const updated = await this.scanModel
      .findOneAndUpdate(
        {
          _id: scanJobId,
          'checkpoint.expandedForkSources': { $nin: [githubId] },
        },
        {
          $addToSet: { 'checkpoint.expandedForkSources': githubId },
          $set: { 'checkpoint.updatedAt': new Date() },
        },
        { new: true },
      )
      .lean()
      .exec();
    return Boolean(updated);
  }

  /**
   * Decide whether content analysis is needed.
   * Identity is always by githubId; fullName is display-only.
   */
  decideRescan(input: {
    mode: ScanMode;
    forceFullScan: boolean;
    rulesetVersion: string;
    existing?: RepositoryDocument | null;
    pushedAt?: Date | string | null;
    updatedAt?: Date | string | null;
    commitSha?: string;
  }): ChangeDecision {
    const { mode, forceFullScan, rulesetVersion, existing, commitSha } = input;

    if (forceFullScan || mode === ScanMode.FULL) {
      return { analyze: true, reason: 'force_full', commitSha };
    }

    if (!existing) {
      return { analyze: true, reason: 'first_seen', commitSha };
    }

    if (mode === ScanMode.FAILED_ONLY) {
      if (existing.lastProcessingFailed) {
        return { analyze: true, reason: 'failed_only', commitSha };
      }
      return { analyze: false, reason: 'unchanged', commitSha };
    }

    if (!existing.lastSuccessfulScanAt) {
      return { analyze: true, reason: 'no_prior_success', commitSha };
    }

    if (existing.lastProcessingFailed) {
      return { analyze: true, reason: 'previous_failed', commitSha };
    }

    if (
      existing.lastRulesetVersion &&
      existing.lastRulesetVersion !== rulesetVersion
    ) {
      return { analyze: true, reason: 'ruleset_changed', commitSha };
    }

    if (commitSha) {
      if (
        existing.lastProcessedCommitSha &&
        existing.lastProcessedCommitSha === commitSha &&
        existing.lastRulesetVersion === rulesetVersion
      ) {
        return { analyze: false, reason: 'unchanged', commitSha };
      }
      if (
        existing.lastProcessedCommitSha &&
        existing.lastProcessedCommitSha !== commitSha
      ) {
        return { analyze: true, reason: 'sha_changed', commitSha };
      }
    }

    const pushedAt = input.pushedAt ? new Date(input.pushedAt).getTime() : 0;
    const storedPushed = existing.githubPushedAt
      ? existing.githubPushedAt.getTime()
      : 0;
    const updatedAt = input.updatedAt ? new Date(input.updatedAt).getTime() : 0;
    const storedUpdated = existing.githubUpdatedAt
      ? existing.githubUpdatedAt.getTime()
      : 0;

    if (
      (pushedAt && pushedAt !== storedPushed) ||
      (updatedAt && updatedAt !== storedUpdated)
    ) {
      return { analyze: true, reason: 'content_changed', commitSha };
    }

    if (
      existing.lastProcessedCommitSha &&
      existing.lastRulesetVersion === rulesetVersion &&
      existing.lastSuccessfulScanAt
    ) {
      return {
        analyze: false,
        reason: 'unchanged',
        commitSha: existing.lastProcessedCommitSha,
      };
    }

    return { analyze: true, reason: 'no_prior_success', commitSha };
  }

  async findByGithubId(workspaceId: string, githubId: number) {
    return this.repoModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        githubId,
      })
      .exec();
  }

  /**
   * Batched equivalent of findByGithubId - one query for the whole list
   * instead of one query per repo, used alongside claimManyForAnalysis so a
   * large pending/failed backlog doesn't turn "look up each repo's saved
   * metadata" into thousands of sequential round-trips on its own.
   */
  async findManyByGithubIds(workspaceId: string, githubIds: number[]) {
    if (githubIds.length === 0) return [];
    return this.repoModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        githubId: { $in: githubIds },
      })
      .exec();
  }

  /**
   * Records that ANOTHER brand's keyword scan also matched a repo already
   * known to the workspace (discovered first by a different brand's scan,
   * or the same brand under a different keyword) - see
   * GitHubSearchProcessor's cross-scan dedup, which otherwise silently
   * drops this fact entirely once a repo is "already known." No-ops if
   * the given brand is already this repo's primary discoverer
   * (discoveryBrandId) or already recorded here, so re-processing the
   * same query's later pages (or a future re-run) doesn't pile up
   * duplicate entries.
   */
  async recordAdditionalBrandMatch(
    workspaceId: string,
    githubId: number,
    match: {
      brandId: string;
      keyword?: string;
      matchedField?: string;
      matchedPath?: string;
      matchedText?: string;
    },
  ): Promise<void> {
    const brandObjectId = new Types.ObjectId(match.brandId);
    await this.repoModel
      .updateOne(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          githubId,
          discoveryBrandId: { $ne: brandObjectId },
          'additionalBrandMatches.brandId': { $ne: brandObjectId },
        },
        {
          $push: {
            additionalBrandMatches: {
              brandId: brandObjectId,
              keyword: match.keyword,
              matchedField: match.matchedField || '',
              matchedPath: match.matchedPath || '',
              matchedText: match.matchedText || '',
              discoveredAt: new Date(),
            },
          },
        },
      )
      .exec();
  }

  async listFailedGithubIds(workspaceId: string): Promise<number[]> {
    const docs = await this.repoModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        lastProcessingFailed: true,
      })
      .select('githubId')
      .lean()
      .exec();
    return docs.map((d) => d.githubId);
  }

  /**
   * Narrows a pendingAnalysis query to a specific brand and/or a
   * discovered-date window - shared by listPendingAnalysisGithubIds and
   * countPendingAnalysis so the button's live count and the actual
   * ANALYZE_PENDING run always agree on exactly the same set of repos.
   * `brandId` matches Repository.discoveryBrandId (whichever brand's scan
   * found the repo FIRST - same convention the Repositories page's Company
   * filter already uses), not additionalBrandMatches - "analyze this
   * brand's backlog" means the repos it's actually credited with finding.
   * `discoveredFrom`/`discoveredTo` filter Repository.createdAt (when THIS
   * workspace found it), matching the Repositories page's own "Discovered"
   * filter - deliberately not GitHub's own created_at, which is a
   * different question answered by the search-time createdFrom/createdTo.
   */
  private buildPendingAnalysisFilter(
    workspaceId: string,
    options: {
      brandId?: string;
      discoveredFrom?: Date;
      discoveredTo?: Date;
    } = {},
  ) {
    const filter: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
      pendingAnalysis: true,
    };
    if (options.brandId) {
      filter.discoveryBrandId = new Types.ObjectId(options.brandId);
    }
    if (options.discoveredFrom || options.discoveredTo) {
      const range: Record<string, Date> = {};
      if (options.discoveredFrom) range.$gte = options.discoveredFrom;
      if (options.discoveredTo) range.$lte = options.discoveredTo;
      filter.createdAt = range;
    }
    return filter;
  }

  /** Every repo a discoveryOnly scan found and saved but never analyzed - see ScanMode.ANALYZE_PENDING. Optionally narrowed to one brand and/or a discovered-date window instead of the whole workspace. */
  async listPendingAnalysisGithubIds(
    workspaceId: string,
    options: {
      brandId?: string;
      discoveredFrom?: Date;
      discoveredTo?: Date;
    } = {},
  ): Promise<number[]> {
    const docs = await this.repoModel
      .find(this.buildPendingAnalysisFilter(workspaceId, options))
      .select('githubId')
      .lean()
      .exec();
    return docs.map((d) => d.githubId);
  }

  /** Cheap count for "N repos discovered and waiting to be analyzed" UI, without loading every id. Same optional brand/date narrowing as listPendingAnalysisGithubIds. */
  async countPendingAnalysis(
    workspaceId: string,
    options: {
      brandId?: string;
      discoveredFrom?: Date;
      discoveredTo?: Date;
    } = {},
  ): Promise<number> {
    return this.repoModel
      .countDocuments(this.buildPendingAnalysisFilter(workspaceId, options))
      .exec();
  }

  logDecision(githubId: number, fullName: string, decision: ChangeDecision) {
    this.logger.log(
      JSON.stringify({
        event: 'scan.incremental.decision',
        githubId,
        fullName,
        analyze: decision.analyze,
        reason: decision.reason,
        commitSha: decision.commitSha,
      }),
    );
  }
}
