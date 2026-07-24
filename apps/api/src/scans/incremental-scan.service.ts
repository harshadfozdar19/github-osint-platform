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
