import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import {
  QUEUE_SCAN_ORCHESTRATOR,
  ScanOrchestratorJobData,
} from '../queue.constants';
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
import {
  Keyword,
  KeywordDocument,
} from '../../keywords/schemas/keyword.schema';
import { ScanJob, ScanJobDocument } from '../../scans/schemas/scan-job.schema';
import {
  SearchQuerySpec,
  buildCreatedQualifier,
} from '../../scans/discovery/query-families';
import {
  safeJobError,
  withJobTimeout,
  sharedWorkerTuning,
} from '../queue.utils';
import { delayJobForGitHubQuota } from '../github-job.utils';
import { ScanCheckpointStage, ScanMode } from '../../common/enums';

@Processor(QUEUE_SCAN_ORCHESTRATOR, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_ORCHESTRATOR || 2),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
  ...sharedWorkerTuning(),
})
export class ScanOrchestratorProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanOrchestratorProcessor.name);

  constructor(
    private readonly scanQueue: ScanQueueService,
    private readonly scanState: ScanStateService,
    private readonly pipeline: ScanPipelineService,
    private readonly incremental: IncrementalScanService,
    private readonly github: GitHubService,
    private readonly config: ConfigService,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    @InjectModel(Keyword.name)
    private readonly keywordModel: Model<KeywordDocument>,
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
  ) {
    super();
  }

  async process(job: Job<ScanOrchestratorJobData>): Promise<void> {
    const { workspaceId, scanJobId } = job.data;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );

    const work = async () => {
      const scan = await this.scanState.assertOwned(workspaceId, scanJobId);

      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.finalize(scanJobId);
        return;
      }

      await this.scanState.markRunning(scanJobId);

      if (!(await this.github.isConfiguredForWorkspace(workspaceId))) {
        await this.scanState.markCompletedEarly(
          scanJobId,
          'No GitHub token available (set a shared GITHUB_TOKEN or add one for this workspace in Settings). Scan skipped live GitHub calls.',
        );
        return;
      }

      if (await this.github.isRateLimited(workspaceId)) {
        const until =
          (await this.github.getPausedUntil(workspaceId)) ||
          Date.now() + 60_000;
        await this.github.markScanPause(scanJobId, until);
        await this.scanState.emitRateLimitPause(scanJobId, until);
        const token = (job as Job & { token?: string }).token || '0';
        await job.moveToDelayed(until, token);
        throw new DelayedError(
          `Orchestrator delayed for GitHub quota until ${new Date(until).toISOString()}`,
        );
      }

      await this.github.clearScanPause(scanJobId);

      const mode =
        (job.data.mode as ScanMode) || scan.mode || ScanMode.INCREMENTAL;
      const forceFullScan =
        job.data.forceFullScan === true ||
        scan.forceFullScan === true ||
        mode === ScanMode.FULL;
      const rulesetVersion =
        job.data.rulesetVersion ||
        scan.rulesetVersion ||
        this.incremental.currentRulesetVersion();

      await this.scanModel.findByIdAndUpdate(scanJobId, {
        mode,
        forceFullScan,
        rulesetVersion,
      });

      // Prefer the value resolved (and clamped to the admin ceiling) at
      // enqueue time; fall back to config for pre-existing scans that
      // predate this field.
      const maxRepos =
        scan.maxRepos ||
        Number(
          this.config.get('MAX_REPOSITORIES') ||
            this.config.get('SCAN_MAX_REPOS') ||
            1000,
        );

      // Resume: failed_only skips search and reprocesses failed github IDs.
      if (mode === ScanMode.FAILED_ONLY) {
        const failedIds =
          await this.incremental.listFailedGithubIds(workspaceId);
        const checkpointIds = scan.checkpoint?.failedGithubIds || [];
        const ids = [...new Set([...failedIds, ...checkpointIds])];
        let enqueued = 0;
        for (const githubId of ids) {
          const claimed = await this.incremental.claimRepositoryForAnalysis(
            scanJobId,
            githubId,
            maxRepos,
          );
          if (!claimed) continue;

          const repo = await this.incremental.findByGithubId(
            workspaceId,
            githubId,
          );
          if (!repo) {
            await this.scanModel.findByIdAndUpdate(scanJobId, {
              $pull: { 'checkpoint.pendingGithubIds': githubId },
            });
            continue;
          }
          await this.scanQueue.enqueueRepositoryAnalysis(
            {
              workspaceId,
              scanJobId,
              mode,
              forceFullScan: true,
              rulesetVersion,
              resumed: true,
              repo: {
                id: repo.githubId,
                full_name: repo.fullName,
                html_url: repo.url,
                description: repo.description,
                stargazers_count: repo.stars,
                forks_count: repo.forks,
                fork: repo.isFork,
                language: repo.language,
                topics: repo.topics,
                created_at: (repo.githubCreatedAt || new Date()).toISOString(),
                updated_at: (repo.githubUpdatedAt || new Date()).toISOString(),
                pushed_at: (repo.githubPushedAt || new Date()).toISOString(),
                owner: { login: repo.owner },
                name: repo.name,
                default_branch: repo.defaultBranch,
              },
            },
            job.opts.priority || 5,
          );
          enqueued += 1;
        }
        await this.scanModel.findByIdAndUpdate(scanJobId, {
          $inc: { awaitingAnalysis: enqueued, reposResumed: enqueued },
          $set: {
            'checkpoint.stage': ScanCheckpointStage.ORCHESTRATED,
            'checkpoint.updatedAt': new Date(),
            message: `Resuming ${enqueued} failed repositories`,
          },
        });
        if (enqueued === 0) {
          await this.scanState.markCompletedEarly(
            scanJobId,
            'No failed repositories to retry',
          );
        }
        return;
      }

      const brands = await this.brandModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          enabled: true,
        })
        .lean()
        .exec();
      const keywords = await this.keywordModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          enabled: true,
        })
        .lean()
        .exec();
      const createdFrom = scan.createdFrom
        ? new Date(scan.createdFrom).toISOString().slice(0, 10)
        : undefined;
      const createdTo = scan.createdTo
        ? new Date(scan.createdTo).toISOString().slice(0, 10)
        : undefined;

      let querySpecs: SearchQuerySpec[];
      if (scan.scopeQuery) {
        const scopeKind = scan.scopeSearchKind || 'repositories';
        const createdQualifier =
          scopeKind === 'repositories'
            ? buildCreatedQualifier(createdFrom, createdTo)
            : undefined;
        querySpecs = [
          {
            kind: scopeKind,
            family: 'custom',
            query: createdQualifier
              ? `${scan.scopeQuery} ${createdQualifier}`
              : scan.scopeQuery,
          },
        ];
      } else {
        const scopedBrands = scan.scopeBrandId
          ? brands.filter((b) => String(b._id) === String(scan.scopeBrandId))
          : brands;
        querySpecs = this.pipeline.buildSearchQueries(scopedBrands, keywords, {
          createdFrom,
          createdTo,
        });
      }
      const queries = querySpecs.map(
        (q) => `[${q.kind}/${q.family}] ${q.query}`,
      );
      await this.scanState.setQueries(scanJobId, queries);
      await this.incremental.saveCheckpoint(scanJobId, {
        stage: ScanCheckpointStage.ORCHESTRATED,
      });

      if (querySpecs.length === 0) {
        await this.scanState.markCompletedEarly(
          scanJobId,
          scan.scopeBrandId
            ? 'Scoped brand is disabled or was not found'
            : 'No enabled brands to search',
        );
        return;
      }

      const cursors = scan.checkpoint?.searchCursors || {};
      for (let i = 0; i < querySpecs.length; i += 1) {
        if (await this.scanState.isCancelled(scanJobId)) {
          await this.scanState.finalize(scanJobId);
          return;
        }
        const resumePage = Number(cursors[String(i)] || 0) + 1;
        const spec = querySpecs[i];
        await this.scanQueue.enqueueGithubSearch(
          {
            workspaceId,
            scanJobId,
            query: spec.query,
            queryIndex: i,
            maxRepos,
            mode,
            forceFullScan,
            rulesetVersion,
            page: resumePage,
            searchKind: spec.kind,
            family: spec.family,
          },
          job.opts.priority || 5,
        );
      }
    };

    try {
      await withJobTimeout(
        work(),
        timeoutMs,
        `Orchestrator timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      if (
        error instanceof DelayedError ||
        (error as Error)?.name === 'DelayedError'
      ) {
        throw error;
      }
      this.logger.error(
        `Orchestrator failed for ${scanJobId}: ${safeJobError(error)}`,
      );
      await this.scanState.markFailed(scanJobId, error);
      if (isGitHubClientError(error) && error.code === 'AUTH') {
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
      throw error;
    }
  }
}
