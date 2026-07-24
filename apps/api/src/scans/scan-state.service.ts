import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ScanJobStatus } from '../common/enums';
import { safeJobError } from '../queues/queue.utils';
import { ScanJob, ScanJobDocument } from './schemas/scan-job.schema';
import { ScanProgressService } from './progress/scan-progress.service';
import {
  ScanProgressEventType,
  ScanProgressPhase,
} from './progress/scan-progress.types';

const ACTIVE_STATUSES = [ScanJobStatus.QUEUED, ScanJobStatus.RUNNING];
const TERMINAL_STATUSES = [
  ScanJobStatus.COMPLETED,
  ScanJobStatus.PARTIALLY_COMPLETED,
  ScanJobStatus.FAILED,
  ScanJobStatus.CANCELLED,
];

@Injectable()
export class ScanStateService {
  private readonly logger = new Logger(ScanStateService.name);

  constructor(
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    private readonly progress: ScanProgressService,
  ) {}

  async getOrThrow(workspaceId: string, scanJobId: string) {
    if (!Types.ObjectId.isValid(scanJobId)) {
      throw new NotFoundException('Scan job not found');
    }
    const job = await this.scanModel
      .findOne({
        _id: scanJobId,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!job) throw new NotFoundException('Scan job not found');
    return job;
  }

  async assertOwned(workspaceId: string, scanJobId: string) {
    return this.getOrThrow(workspaceId, scanJobId);
  }

  async findActiveDuplicate(workspaceId: string, configHash: string) {
    return this.scanModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        configHash,
        status: { $in: ACTIVE_STATUSES },
      })
      .lean()
      .exec();
  }

  async markRunning(scanJobId: string) {
    const job = await this.scanModel.findByIdAndUpdate(
      scanJobId,
      {
        status: ScanJobStatus.RUNNING,
        startedAt: new Date(),
        message: 'Scan running',
      },
      { new: true },
    );
    if (job) {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.STARTED,
        phase: ScanProgressPhase.ORCHESTRATING,
        status: ScanJobStatus.RUNNING,
        message: 'Scan started',
        force: true,
      });
    }
    return job;
  }

  async requestCancel(workspaceId: string, scanJobId: string) {
    const job = await this.getOrThrow(workspaceId, scanJobId);
    if (
      job.status === ScanJobStatus.COMPLETED ||
      job.status === ScanJobStatus.PARTIALLY_COMPLETED ||
      job.status === ScanJobStatus.CANCELLED ||
      job.status === ScanJobStatus.FAILED
    ) {
      return job;
    }
    job.cancelRequested = true;
    if (job.status === ScanJobStatus.QUEUED) {
      job.status = ScanJobStatus.CANCELLED;
      job.finishedAt = new Date();
      job.message = 'Scan cancelled before workers started';
      await job.save();
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.CANCELLED,
        phase: ScanProgressPhase.CANCELLED,
        status: ScanJobStatus.CANCELLED,
        message: job.message,
        terminal: true,
        force: true,
      });
      return job;
    }
    await job.save();
    await this.progress.emitFromScanId(scanJobId, {
      type: ScanProgressEventType.WARNING,
      phase: ScanProgressPhase.FINALIZING,
      status: job.status,
      message: 'Cancel requested — finishing in-flight work',
      force: true,
    });
    return job;
  }

  async isCancelled(scanJobId: string): Promise<boolean> {
    const job = await this.scanModel
      .findById(scanJobId)
      .select('cancelRequested status')
      .lean()
      .exec();
    if (!job) return true;
    return (
      job.cancelRequested === true || job.status === ScanJobStatus.CANCELLED
    );
  }

  /**
   * True once the scan has reached ANY terminal state (completed,
   * partially_completed, failed, cancelled) — not just cancelled. Workers
   * must check this before making outbound GitHub calls or enqueueing more
   * work: a scan can finalize while stragglers from its own job graph (or a
   * retried/delayed job) are still in flight, and without this check those
   * stragglers keep hitting the GitHub API indefinitely after the UI already
   * shows "completed".
   */
  async isTerminal(scanJobId: string): Promise<boolean> {
    const job = await this.scanModel
      .findById(scanJobId)
      .select('status')
      .lean()
      .exec();
    if (!job) return true;
    return TERMINAL_STATUSES.includes(job.status);
  }

  async setQueries(scanJobId: string, queries: string[]) {
    const job = await this.scanModel.findByIdAndUpdate(
      scanJobId,
      {
        queriesUsed: queries,
        awaitingSearch: queries.length,
        message: `Queued ${queries.length} search queries`,
      },
      { new: true },
    );
    if (job) {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.SEARCH_PROGRESS,
        phase: ScanProgressPhase.SEARCHING,
        status: ScanJobStatus.RUNNING,
        message: `Searching GitHub (${queries.length} queries)`,
        counts: {
          queriesTotal: queries.length,
          queriesCompleted: 0,
        },
      });
    }
    return job;
  }

  async completeSearchJob(scanJobId: string, analysisEnqueued: number) {
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $inc: {
        awaitingSearch: -1,
        awaitingAnalysis: analysisEnqueued,
        reposDiscovered: analysisEnqueued,
        reposFound: analysisEnqueued,
        reposTotal: analysisEnqueued,
      },
    });
    await this.progress.emitFromScanId(scanJobId, {
      type:
        analysisEnqueued > 0
          ? ScanProgressEventType.REPOSITORIES_DISCOVERED
          : ScanProgressEventType.SEARCH_PROGRESS,
      phase: ScanProgressPhase.SEARCHING,
      status: ScanJobStatus.RUNNING,
      message:
        analysisEnqueued > 0
          ? `Discovered ${analysisEnqueued} repositories from search`
          : 'Search query completed',
    });
    return this.tryFinalize(scanJobId);
  }

  /**
   * Record repos discovered via owner/fork expansion (not a search child job).
   * Increments awaitingAnalysis so finalize waits for the new work.
   */
  async recordExpansionEnqueued(scanJobId: string, analysisEnqueued: number) {
    if (analysisEnqueued <= 0) return null;
    const job = await this.scanModel.findByIdAndUpdate(
      scanJobId,
      {
        $inc: {
          awaitingAnalysis: analysisEnqueued,
          reposDiscovered: analysisEnqueued,
          reposFound: analysisEnqueued,
          reposTotal: analysisEnqueued,
        },
      },
      { new: true },
    );
    await this.progress.emitFromScanId(scanJobId, {
      type: ScanProgressEventType.REPOSITORIES_DISCOVERED,
      phase: ScanProgressPhase.ANALYZING,
      status: ScanJobStatus.RUNNING,
      message: `Expanded discovery by ${analysisEnqueued} related repositories`,
    });
    return job;
  }

  /**
   * Idempotent resume helper: analysis job reappeared for a githubId already
   * finished in this scan. Decrement outstanding work without double-counting
   * reposProcessed.
   */
  async acknowledgeAlreadyCompletedUnit(scanJobId: string) {
    await this.scanModel.findOneAndUpdate(
      { _id: scanJobId, awaitingAnalysis: { $gt: 0 } },
      {
        $inc: {
          awaitingAnalysis: -1,
          reposResumed: 1,
        },
      },
    );
    return this.tryFinalize(scanJobId);
  }

  async completeAnalysisUnit(
    scanJobId: string,
    opts: {
      failed?: boolean;
      skipped?: boolean;
      rescanned?: boolean;
      resumed?: boolean;
      findingsCreated?: number;
      findingsUpdated?: number;
      findingsNew?: number;
      findingsUnchanged?: number;
      findingsReopened?: number;
      findingsResolved?: number;
      failedKey?: string;
      githubId?: number;
    },
  ) {
    const update: {
      $inc: Record<string, number>;
      $addToSet?: Record<string, number | string>;
      $pull?: Record<string, number | string>;
    } = {
      $inc: {
        awaitingAnalysis: -1,
        reposProcessed: 1,
        reposAnalyzed: 1,
      },
    };
    if (opts.failed) update.$inc.reposFailed = 1;
    if (opts.skipped) update.$inc.reposSkipped = 1;
    if (opts.rescanned) update.$inc.reposRescanned = 1;
    if (opts.resumed) update.$inc.reposResumed = 1;
    if (opts.findingsCreated) {
      update.$inc.findingsCreated = opts.findingsCreated;
    }
    if (opts.findingsUpdated) {
      update.$inc.findingsUpdated = opts.findingsUpdated;
    }
    if (opts.findingsNew) update.$inc.findingsNew = opts.findingsNew;
    if (opts.findingsUnchanged) {
      update.$inc.findingsUnchanged = opts.findingsUnchanged;
    }
    if (opts.findingsReopened) {
      update.$inc.findingsReopened = opts.findingsReopened;
    }
    if (opts.findingsResolved) {
      update.$inc.findingsResolved = opts.findingsResolved;
    }
    if (opts.failedKey) {
      update.$addToSet = {
        ...(update.$addToSet || {}),
        failedRepoKeys: opts.failedKey,
      };
    }
    if (opts.githubId !== undefined) {
      update.$addToSet = {
        ...(update.$addToSet || {}),
        'checkpoint.completedGithubIds': opts.githubId,
      };
      update.$pull = {
        ...(update.$pull || {}),
        'checkpoint.pendingGithubIds': opts.githubId,
      };
      if (opts.skipped) {
        update.$addToSet['checkpoint.skippedGithubIds'] = opts.githubId;
      }
      if (opts.failed) {
        update.$addToSet['checkpoint.failedGithubIds'] = opts.githubId;
      }
    }
    await this.scanModel.findByIdAndUpdate(scanJobId, update);

    if (opts.failed) {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.WARNING,
        phase: ScanProgressPhase.ANALYZING,
        status: ScanJobStatus.RUNNING,
        message: 'A repository failed analysis and will be skipped',
      });
    } else if (opts.skipped) {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.REPOSITORIES_PROCESSED,
        phase: ScanProgressPhase.ANALYZING,
        status: ScanJobStatus.RUNNING,
        message: 'Skipped unchanged repository (incremental)',
      });
    } else if (opts.findingsCreated && opts.findingsCreated > 0) {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.FINDINGS_CREATED,
        phase: ScanProgressPhase.ANALYZING,
        status: ScanJobStatus.RUNNING,
        message: `Created ${opts.findingsCreated} finding(s)`,
      });
    } else {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.REPOSITORIES_PROCESSED,
        phase: ScanProgressPhase.ANALYZING,
        status: ScanJobStatus.RUNNING,
        message: 'Repository processed',
      });
    }

    return this.tryFinalize(scanJobId);
  }

  async tryFinalize(scanJobId: string) {
    const job = await this.scanModel.findById(scanJobId).exec();
    if (!job) return null;
    if (
      [
        ScanJobStatus.COMPLETED,
        ScanJobStatus.PARTIALLY_COMPLETED,
        ScanJobStatus.FAILED,
        ScanJobStatus.CANCELLED,
      ].includes(job.status)
    ) {
      return job;
    }
    if (job.cancelRequested) {
      return this.finalize(scanJobId);
    }

    const awaitingSearch = job.awaitingSearch || 0;
    const awaitingAnalysis = job.awaitingAnalysis || 0;

    // Finalize only once BOTH counters are drained. Search jobs always
    // self-report via completeSearchJob (success, maxRepos-cap no-op, or
    // final-attempt failure all decrement it), so awaitingSearch reliably
    // reaches 0 on its own — there is no need (and it is actively harmful)
    // to infer "search is effectively done" from awaitingAnalysis alone.
    // Analysis routinely drains to 0 in between search pages/queries simply
    // because it's faster than discovery, which would otherwise trigger a
    // premature finalize and abandon the remaining, not-yet-run queries.
    if (awaitingSearch <= 0 && awaitingAnalysis <= 0) {
      return this.finalize(scanJobId);
    }

    return job;
  }

  async finalize(scanJobId: string) {
    const job = await this.scanModel.findById(scanJobId).exec();
    if (!job) return null;
    if (job.cancelRequested || job.status === ScanJobStatus.CANCELLED) {
      job.status = ScanJobStatus.CANCELLED;
      job.message = 'Scan cancelled';
      job.finishedAt = new Date();
      await job.save();
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.CANCELLED,
        phase: ScanProgressPhase.CANCELLED,
        status: ScanJobStatus.CANCELLED,
        message: 'Scan cancelled',
        terminal: true,
        force: true,
        percent: 100,
      });
      return job;
    }

    const failed = job.reposFailed || 0;
    const processed = job.reposProcessed || 0;

    if (failed > 0 && processed > failed) {
      job.status = ScanJobStatus.PARTIALLY_COMPLETED;
      job.message = `Completed with ${failed} failed of ${processed} processed repositories`;
    } else if (failed > 0 && processed === failed && processed > 0) {
      job.status = ScanJobStatus.FAILED;
      job.message = 'All repository analyses failed';
      job.error = job.error || 'All repository analyses failed';
    } else {
      job.status = ScanJobStatus.COMPLETED;
      const skipped = job.reposSkipped || 0;
      const rescanned = job.reposRescanned || 0;
      job.message = `Analyzed ${processed} repositories (${skipped} skipped, ${rescanned} rescanned)`;
    }
    job.finishedAt = new Date();
    if (job.checkpoint) {
      job.checkpoint.stage = 'finalized';
      job.checkpoint.updatedAt = new Date();
    }
    await job.save();

    if (job.status === ScanJobStatus.FAILED) {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.FAILED,
        phase: ScanProgressPhase.FAILED,
        status: ScanJobStatus.FAILED,
        message: job.message,
        terminal: true,
        force: true,
      });
    } else {
      await this.progress.emitFromScanId(scanJobId, {
        type: ScanProgressEventType.COMPLETED,
        phase: ScanProgressPhase.COMPLETED,
        status: job.status,
        message: job.message,
        terminal: true,
        force: true,
        percent: 100,
      });
    }
    return job;
  }

  async emitRateLimitPause(scanJobId: string, until: number) {
    await this.progress.emitFromScanId(scanJobId, {
      type: ScanProgressEventType.WARNING,
      phase: ScanProgressPhase.SEARCHING,
      status: ScanJobStatus.RUNNING,
      message: `Paused for GitHub rate limit until ${new Date(until).toISOString()}`,
      force: true,
    });
  }

  async markFailed(scanJobId: string, error: unknown) {
    const message = safeJobError(error);
    this.logger.warn(`Scan ${scanJobId} failed: ${message}`);
    const job = await this.scanModel.findByIdAndUpdate(
      scanJobId,
      {
        status: ScanJobStatus.FAILED,
        error: message,
        message: 'Scan failed',
        finishedAt: new Date(),
        awaitingSearch: 0,
        awaitingAnalysis: 0,
      },
      { new: true },
    );
    await this.progress.emitFromScanId(scanJobId, {
      type: ScanProgressEventType.FAILED,
      phase: ScanProgressPhase.FAILED,
      status: ScanJobStatus.FAILED,
      message: 'Scan failed',
      terminal: true,
      force: true,
    });
    return job;
  }

  async markCompletedEarly(scanJobId: string, message: string) {
    const job = await this.scanModel.findByIdAndUpdate(
      scanJobId,
      {
        status: ScanJobStatus.COMPLETED,
        message,
        finishedAt: new Date(),
        startedAt: new Date(),
        awaitingSearch: 0,
        awaitingAnalysis: 0,
      },
      { new: true },
    );
    await this.progress.emitFromScanId(scanJobId, {
      type: ScanProgressEventType.COMPLETED,
      phase: ScanProgressPhase.COMPLETED,
      status: ScanJobStatus.COMPLETED,
      message,
      terminal: true,
      force: true,
      percent: 100,
    });
    return job;
  }
}
