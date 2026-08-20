import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ScanJobStatus, TERMINAL_SCAN_STATUSES } from '../common/enums';
import { safeJobError } from '../queues/queue.utils';
import { ScanJob, ScanJobDocument } from './schemas/scan-job.schema';
import { ScanProgressService } from './progress/scan-progress.service';
import {
  ScanProgressEventType,
  ScanProgressPhase,
} from './progress/scan-progress.types';
import { ScanQueueService } from '../queues/scan-queue.service';

const ACTIVE_STATUSES = [ScanJobStatus.QUEUED, ScanJobStatus.RUNNING];
const TERMINAL_STATUSES = TERMINAL_SCAN_STATUSES;

/**
 * How long to wait before automatically starting the next run for the same
 * keyword-watch scan - see maybeRestartKeywordWatch. Flat regardless of
 * whether the run that just finished found anything new - a longer cooldown
 * for empty results was tried first (to avoid re-searching an exhausted
 * query pointlessly), but a fast, uniform recheck was chosen instead,
 * accepting the extra GitHub request volume it costs across every
 * concurrently watched keyword. Overridable for tests/tuning.
 */
const KEYWORD_WATCH_RESTART_DELAY_MS_DEFAULT = 30_000;

@Injectable()
export class ScanStateService {
  private readonly logger = new Logger(ScanStateService.name);

  constructor(
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    private readonly progress: ScanProgressService,
    @Inject(forwardRef(() => ScanQueueService))
    private readonly scanQueue: ScanQueueService,
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

  /**
   * Bumps discovery counters for exactly one newly claimed repo. Callers
   * must call this immediately after claimRepositoryForAnalysis succeeds
   * and BEFORE enqueueing that repo's analysis job - not batched at the end
   * of a whole search-page loop the way this used to work. Batching it
   * raced against concurrent analysis workers: with WORKER_CONCURRENCY_
   * REPO_ANALYSIS > 1, a fast "skip - unchanged" decision for repo #1 of a
   * 20-repo page could call completeAnalysisUnit (reposProcessed += 1)
   * while the search processor was still on repo #15 of the same page's
   * enqueue loop, well before the batched reposDiscovered increment landed
   * - visible on the scan detail page as reposProcessed transiently
   * exceeding reposDiscovered. No progress emit here (would be one SSE
   * event per repo); the caller's own batch-level emit still fires after
   * its loop completes.
   *
   * `countsTowardAnalysis` (default true) controls whether this claim also
   * bumps awaitingAnalysis - true for every normal caller, which always
   * follows this with an enqueueRepositoryAnalysis job that will eventually
   * call completeAnalysisUnit to decrement it back. Pass false for a
   * discoveryOnly claim: no analysis job is ever enqueued for it, so
   * incrementing awaitingAnalysis here would leave it permanently above
   * zero and the scan would never finalize (tryFinalize requires both
   * awaitingSearch AND awaitingAnalysis to reach 0). Increments
   * reposPendingAnalysis instead, so the deferred count is still visible.
   */
  async recordRepositoryDiscovered(
    scanJobId: string,
    options: { countsTowardAnalysis?: boolean } = {},
  ) {
    const countsTowardAnalysis = options.countsTowardAnalysis !== false;
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $inc: {
        awaitingAnalysis: countsTowardAnalysis ? 1 : 0,
        reposDiscovered: 1,
        reposFound: 1,
        reposTotal: 1,
        reposPendingAnalysis: countsTowardAnalysis ? 0 : 1,
      },
    });
  }

  async completeSearchJob(scanJobId: string, analysisEnqueued: number) {
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $inc: { awaitingSearch: -1 },
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
   * Reports repos discovered via owner/fork expansion (not a search child
   * job) - counters themselves are already incremented per-repo by
   * recordRepositoryDiscovered as each one is claimed, same as the search
   * path; this just emits the batch-level progress message once the whole
   * expansion loop finishes.
   */
  async recordExpansionEnqueued(scanJobId: string, analysisEnqueued: number) {
    if (analysisEnqueued <= 0) return null;
    await this.progress.emitFromScanId(scanJobId, {
      type: ScanProgressEventType.REPOSITORIES_DISCOVERED,
      phase: ScanProgressPhase.ANALYZING,
      status: ScanJobStatus.RUNNING,
      message: `Expanded discovery by ${analysisEnqueued} related repositories`,
    });
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
      findingsHighRisk?: number;
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
    if (opts.findingsHighRisk) {
      update.$inc.findingsHighRisk = opts.findingsHighRisk;
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

    // A keyword-watch toggle is meant to stay "on" until the user turns it
    // off, not until it happens to run out of results - GitHub's index
    // changes over time, so a keyword that found nothing new today might
    // find something next week. Only fires for a clean, error-free
    // COMPLETED finish (never for CANCELLED - handled by the early return
    // above - or FAILED, which would just repeat the same failure forever).
    if (job.status === ScanJobStatus.COMPLETED && !job.error) {
      await this.maybeRestartKeywordWatch(job);
    }
    return job;
  }

  /**
   * Re-enqueues the same keyword-scoped discoveryOnly scan after a cooldown
   * so it keeps effectively "running" (QUEUED, visible as active) until the
   * user explicitly stops it via cancelScan - see finalize(). Reuses every
   * option the original run had (dates, custom query overrides, maxRepos)
   * and resumes from where its discovery cursor left off (continueDiscovery)
   * instead of re-walking the same top results every cycle. Best-effort: a
   * failure here (e.g. the brand was deleted in the meantime) just means
   * this keyword quietly stops watching, not a crash.
   */
  private async maybeRestartKeywordWatch(job: ScanJobDocument) {
    if (!job.scopeKeyword || !job.scopeBrandId || job.discoveryOnly !== true) {
      return;
    }
    // A rotation-managed scan's "what runs next" is owned entirely by
    // KeywordRotationService.advance (the next keyword in its own order,
    // not this same keyword again) - restarting it here would race the
    // rotation's own handoff and leave two competing scans for this brand.
    if (job.rotationManaged) {
      return;
    }
    const toDateString = (d?: Date) =>
      d ? d.toISOString().slice(0, 10) : undefined;
    const envOverride = Number(process.env.KEYWORD_WATCH_RESTART_DELAY_MS);
    const delayMs =
      envOverride > 0 ? envOverride : KEYWORD_WATCH_RESTART_DELAY_MS_DEFAULT;
    try {
      await this.scanQueue.enqueueManualScan(
        String(job.workspaceId),
        String(job.triggeredBy),
        {
          brandId: String(job.scopeBrandId),
          keyword: job.scopeKeyword,
          discoveryOnly: true,
          maxRepos: job.maxRepos,
          createdFrom: toDateString(job.createdFrom),
          createdTo: toDateString(job.createdTo),
          pushedFrom: toDateString(job.pushedFrom),
          pushedTo: toDateString(job.pushedTo),
          dateFilterMode: job.dateFilterMode,
          customRepoQuery: job.customRepoQuery,
          customCodeQuery: job.customCodeQuery,
          continueDiscovery: true,
          delayMs,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Keyword watch auto-restart skipped for scan ${String(job._id)} (keyword "${job.scopeKeyword}"): ${safeJobError(err)}`,
      );
    }
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
