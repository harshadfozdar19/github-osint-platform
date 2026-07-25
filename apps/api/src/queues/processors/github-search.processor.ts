import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import { QUEUE_GITHUB_SEARCH, GitHubSearchJobData } from '../queue.constants';
import { ScanQueueService } from '../scan-queue.service';
import { ScanStateService } from '../../scans/scan-state.service';
import { ScanPipelineService } from '../../scans/scan-pipeline.service';
import { IncrementalScanService } from '../../scans/incremental-scan.service';
import {
  GitHubService,
  isGitHubClientError,
} from '../../github/github.service';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../../brands/schemas/monitored-brand.schema';
import { ScanJob, ScanJobDocument } from '../../scans/schemas/scan-job.schema';
import { safeJobError, isFinalAttempt, withJobTimeout } from '../queue.utils';
import { delayJobForGitHubQuota } from '../github-job.utils';
import { ScanCheckpointStage, ScanMode } from '../../common/enums';

@Processor(QUEUE_GITHUB_SEARCH, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_GITHUB_SEARCH || 2),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
})
export class GitHubSearchProcessor extends WorkerHost {
  private readonly logger = new Logger(GitHubSearchProcessor.name);

  constructor(
    private readonly scanQueue: ScanQueueService,
    private readonly scanState: ScanStateService,
    private readonly pipeline: ScanPipelineService,
    private readonly incremental: IncrementalScanService,
    private readonly github: GitHubService,
    private readonly config: ConfigService,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
  ) {
    super();
  }

  async process(job: Job<GitHubSearchJobData>): Promise<void> {
    const { workspaceId, scanJobId, query, maxRepos } = job.data;
    const page = job.data.page || 1;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );
    const abort = new AbortController();

    try {
      await this.scanState.assertOwned(workspaceId, scanJobId);
      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.completeSearchJob(scanJobId, 0);
        return;
      }

      const work = async () => {
        const scan = await this.scanModel.findById(scanJobId).lean().exec();

        // Bail out early if the scan is already in a terminal state or at cap.
        const terminalStatuses = [
          'completed',
          'partially_completed',
          'failed',
          'cancelled',
        ];
        if (scan && terminalStatuses.includes(scan.status)) {
          this.logger.log(
            `Search skipped: scan ${scanJobId} already ${scan.status}`,
          );
          return;
        }
        const already = scan?.reposDiscovered || 0;
        if (already >= maxRepos) {
          await this.scanState.completeSearchJob(scanJobId, 0);
          return;
        }

        const mode =
          (job.data.mode as ScanMode) ||
          (scan?.mode as ScanMode) ||
          ScanMode.INCREMENTAL;
        const forceFullScan =
          job.data.forceFullScan === true || scan?.forceFullScan === true;
        const rulesetVersion =
          job.data.rulesetVersion ||
          scan?.rulesetVersion ||
          this.incremental.currentRulesetVersion();

        const batchSize = Number(this.config.get('SEARCH_BATCH_SIZE') || 100);

        const result =
          (job.data.searchKind || 'repositories') === 'code'
            ? await this.github.searchCode(query, page, batchSize, {
                workspaceId,
                scanJobId,
                signal: abort.signal,
              })
            : await this.github.searchRepositories(query, page, batchSize, {
                workspaceId,
                scanJobId,
                signal: abort.signal,
              });
        await this.github.clearScanPause(scanJobId);

        const brands = await this.brandModel
          .find({
            workspaceId: new Types.ObjectId(workspaceId),
            enabled: true,
          })
          .lean()
          .exec();

        let enqueued = 0;
        for (const item of result.items) {
          if (await this.scanState.isCancelled(scanJobId)) break;

          const claimed = await this.incremental.claimRepositoryForAnalysis(
            scanJobId,
            item.id,
            maxRepos,
          );
          if (!claimed) continue;

          const matched = this.pipeline.matchBrand(brands, item);
          await this.scanQueue.enqueueRepositoryAnalysis(
            {
              workspaceId,
              scanJobId,
              mode,
              forceFullScan,
              rulesetVersion,
              repo: {
                id: item.id,
                full_name: item.full_name,
                html_url: item.html_url,
                description: item.description,
                stargazers_count: item.stargazers_count,
                forks_count: item.forks_count,
                fork: item.fork,
                language: item.language,
                topics: item.topics,
                created_at: item.created_at,
                updated_at: item.updated_at,
                pushed_at: item.pushed_at,
                owner: { login: item.owner.login },
                name: item.name,
                default_branch: item.default_branch,
                size: item.size,
              },
              matchedBrand: matched
                ? {
                    id: String(matched._id),
                    name: matched.name,
                    aliases: matched.aliases,
                  }
                : undefined,
            },
            job.opts.priority || 5,
          );
          enqueued += 1;
        }

        await this.incremental.saveCheckpoint(scanJobId, {
          stage: ScanCheckpointStage.SEARCH,
          searchCursors: {
            ...(scan?.checkpoint?.searchCursors || {}),
            [String(job.data.queryIndex)]: page,
          },
        });

        // Determine if there are more pages and we haven't hit the limit yet
        const hasMoreResults =
          result.items.length === batchSize &&
          result.total_count > page * batchSize;
        const currentReposDiscovered = (scan?.reposDiscovered || 0) + enqueued;

        if (hasMoreResults && currentReposDiscovered < maxRepos) {
          await this.scanModel.findByIdAndUpdate(scanJobId, {
            $inc: { awaitingSearch: 1 },
          });
          await this.scanQueue.enqueueGithubSearch(
            {
              workspaceId,
              scanJobId,
              query,
              queryIndex: job.data.queryIndex,
              maxRepos,
              mode,
              forceFullScan,
              rulesetVersion,
              page: page + 1,
              searchKind: job.data.searchKind,
              family: job.data.family,
            },
            job.opts.priority || 5,
          );
        }

        await this.scanState.completeSearchJob(scanJobId, enqueued);
      };

      await withJobTimeout(
        work(),
        timeoutMs,
        `GitHub search timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      abort.abort();
      if (
        error instanceof DelayedError ||
        (error as Error)?.name === 'DelayedError'
      ) {
        throw error;
      }
      this.logger.warn(
        `GitHub search failed for scan ${scanJobId}: ${safeJobError(error)}`,
      );

      // 401 AUTH error: token invalid/expired — fail fast without retrying
      if (isGitHubClientError(error) && error.code === 'AUTH') {
        await this.scanModel.findByIdAndUpdate(scanJobId, {
          message: 'GitHub authentication failed — check GITHUB_TOKEN',
          error: 'GitHub authentication failed (401 Unauthorized)',
        });
        await this.scanState.completeSearchJob(scanJobId, 0);
        return;
      }

      try {
        await delayJobForGitHubQuota(job, error, this.github, this.scanState);
      } catch (delayed) {
        if (
          delayed instanceof DelayedError ||
          (delayed as Error)?.name === 'DelayedError'
        ) {
          throw delayed;
        }
      }
      if (isFinalAttempt(job)) {
        await this.scanState.completeSearchJob(scanJobId, 0);
      }
      throw error;
    }
  }
}
