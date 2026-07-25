import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import {
  QUEUE_REPOSITORY_ANALYSIS,
  RepositoryAnalysisJobData,
} from '../queue.constants';
import { ScanQueueService } from '../scan-queue.service';
import { ScanStateService } from '../../scans/scan-state.service';
import { ScanPipelineService } from '../../scans/scan-pipeline.service';
import { IncrementalScanService } from '../../scans/incremental-scan.service';
import { GitHubService } from '../../github/github.service';
import {
  safeJobError,
  isFinalAttempt,
  withJobTimeout,
  sharedWorkerTuning,
} from '../queue.utils';
import { delayJobForGitHubQuota } from '../github-job.utils';
import { ScanMode } from '../../common/enums';

@Processor(QUEUE_REPOSITORY_ANALYSIS, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_REPO_ANALYSIS || 3),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
  ...sharedWorkerTuning(),
})
export class RepositoryAnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(RepositoryAnalysisProcessor.name);

  constructor(
    private readonly scanQueue: ScanQueueService,
    private readonly scanState: ScanStateService,
    private readonly pipeline: ScanPipelineService,
    private readonly incremental: IncrementalScanService,
    private readonly github: GitHubService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<RepositoryAnalysisJobData>): Promise<void> {
    const { workspaceId, scanJobId, repo, matchedBrand } = job.data;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );
    let detectionEnqueued = false;
    const abort = new AbortController();

    try {
      await this.scanState.assertOwned(workspaceId, scanJobId);
      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.completeAnalysisUnit(scanJobId, {
          failed: false,
          githubId: repo.id,
        });
        return;
      }
      if (await this.scanState.isTerminal(scanJobId)) {
        this.logger.log(
          `Repo analysis skipped: scan ${scanJobId} already finalized`,
        );
        return;
      }

      // Idempotent resume: skip content work if this githubId already finished.
      if (await this.incremental.isAlreadyCompleted(scanJobId, repo.id)) {
        await this.scanState.acknowledgeAlreadyCompletedUnit(scanJobId);
        return;
      }

      const work = async () => {
        const mode = (job.data.mode as ScanMode) || ScanMode.INCREMENTAL;
        const forceFullScan = job.data.forceFullScan === true;
        const rulesetVersion =
          job.data.rulesetVersion || this.incremental.currentRulesetVersion();

        const existing = await this.incremental.findByGithubId(
          workspaceId,
          repo.id,
        );

        // HEAD SHA check is cheap and required for accurate skip; not content analysis.
        const [owner, name] = repo.full_name.split('/');
        const head = await this.github.getRepositoryHead(owner, name, {
          workspaceId,
          scanJobId,
          signal: abort.signal,
        });

        const decision = this.incremental.decideRescan({
          mode,
          forceFullScan,
          rulesetVersion,
          existing,
          pushedAt: head?.pushedAt || repo.pushed_at,
          updatedAt: head?.updatedAt || repo.updated_at,
          commitSha: head?.sha,
        });

        this.incremental.logDecision(repo.id, repo.full_name, decision);

        if (!decision.analyze) {
          await this.pipeline.upsertRepository(workspaceId, repo, {
            defaultBranch:
              head?.defaultBranch ||
              repo.default_branch ||
              existing?.defaultBranch,
            commitSha: decision.commitSha || existing?.lastProcessedCommitSha,
            rulesetVersion,
            scanJobId,
            markSuccess: true,
          });
          await this.scanState.completeAnalysisUnit(scanJobId, {
            skipped: true,
            githubId: repo.id,
          });
          return;
        }

        const upserted = await this.pipeline.upsertRepository(
          workspaceId,
          repo,
          {
            defaultBranch: head?.defaultBranch || repo.default_branch,
            scanJobId,
          },
        );
        const fetched = await this.pipeline.fetchRepositoryContext(
          repo,
          matchedBrand,
          { workspaceId, scanJobId, signal: abort.signal },
          { commitSha: head?.sha || decision.commitSha },
        );

        // Git-history scan is opt-in and costs extra GitHub requests per repo
        // (a commits list + one call per commit), so it's bounded to repos
        // that already matched a monitored brand rather than every discovery.
        const historySha = head?.sha || decision.commitSha;
        if (
          matchedBrand &&
          historySha &&
          String(this.config.get('ENABLE_GIT_HISTORY_SCAN')).toLowerCase() ===
            'true'
        ) {
          await this.pipeline.appendHistoricalSecretSignals(
            owner,
            name,
            historySha,
            fetched.ctx,
            { workspaceId, scanJobId, signal: abort.signal },
          );
        }

        await this.github.clearScanPause(scanJobId);

        await this.scanQueue.enqueueDetection(
          {
            workspaceId,
            scanJobId,
            repositoryDbId: String(upserted._id),
            githubId: repo.id,
            fullName: repo.full_name,
            commitSha: head?.sha || decision.commitSha,
            defaultBranch: head?.defaultBranch || repo.default_branch,
            contentEtag: head?.etag,
            rulesetVersion,
            resumed: job.data.resumed === true,
            ctx: {
              fullName: fetched.ctx.fullName,
              owner: fetched.ctx.owner,
              name: fetched.ctx.name,
              description: fetched.ctx.description,
              topics: fetched.ctx.topics,
              language: fetched.ctx.language,
              stars: fetched.ctx.stars,
              forks: fetched.ctx.forks,
              isFork: fetched.ctx.isFork,
              githubCreatedAt: fetched.ctx.githubCreatedAt?.toISOString(),
              githubPushedAt: fetched.ctx.githubPushedAt?.toISOString(),
              filePaths: fetched.ctx.filePaths,
              readmeText: fetched.ctx.readmeText,
              smallFileTexts: fetched.ctx.smallFileTexts,
              matchedBrandName: fetched.ctx.matchedBrandName,
              matchedBrandAliases: fetched.ctx.matchedBrandAliases,
            },
          },
          job.opts.priority || 5,
        );
        detectionEnqueued = true;
      };

      await withJobTimeout(
        work(),
        timeoutMs,
        `Repository analysis timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      abort.abort();
      if (
        error instanceof DelayedError ||
        (error as Error)?.name === 'DelayedError'
      ) {
        throw error;
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
      this.logger.warn(
        `Repo analysis failed ${repo.full_name}: ${safeJobError(error)}`,
      );
      if (!detectionEnqueued && isFinalAttempt(job)) {
        await this.pipeline.upsertRepository(workspaceId, repo, {
          scanJobId,
          markFailed: true,
        });
        await this.scanState.completeAnalysisUnit(scanJobId, {
          failed: true,
          failedKey: `${repo.id}:${repo.full_name}`,
          githubId: repo.id,
        });
      }
      throw error;
    }
  }
}
