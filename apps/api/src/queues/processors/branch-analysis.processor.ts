import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import {
  QUEUE_BRANCH_ANALYSIS,
  BranchAnalysisJobData,
} from '../queue.constants';
import { ScanStateService } from '../../scans/scan-state.service';
import { ScanPipelineService } from '../../scans/scan-pipeline.service';
import { GitHubService } from '../../github/github.service';
import { CloneScanService } from '../../scans/clone-scan.service';
import { Severity } from '../../common/enums';
import {
  safeJobError,
  isFinalAttempt,
  withJobTimeout,
  sharedWorkerTuning,
  watchForCancellation,
} from '../queue.utils';
import { delayJobForGitHubQuota } from '../github-job.utils';

/**
 * Runs exactly one ScanMode.BRANCH_ANALYSIS scan: clone+scan ONE known
 * repository's ONE known branch, run detection, persist findings. Far
 * simpler than RepositoryAnalysisProcessor + DetectionProcessingProcessor
 * combined (no incremental-rescan decision, no discovery-derived metadata,
 * always exactly one unit) - and deliberately does NOT call
 * ScanPipelineService.upsertRepository at all, since that would overwrite
 * Repository's own default-branch bookkeeping (lastProcessedCommitSha/
 * defaultBranch/lastScannedAt) with this side branch's values, corrupting
 * the incremental decision the NORMAL default-branch pipeline relies on for
 * this same repo.
 */
@Processor(QUEUE_BRANCH_ANALYSIS, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_BRANCH_ANALYSIS || 2),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
  ...sharedWorkerTuning(),
})
export class BranchAnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(BranchAnalysisProcessor.name);

  constructor(
    private readonly scanState: ScanStateService,
    private readonly pipeline: ScanPipelineService,
    private readonly github: GitHubService,
    private readonly config: ConfigService,
    private readonly cloneScan: CloneScanService,
  ) {
    super();
  }

  async process(job: Job<BranchAnalysisJobData>): Promise<void> {
    const {
      workspaceId,
      scanJobId,
      repositoryDbId,
      githubId,
      fullName,
      branch,
      brands,
    } = job.data;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );
    const abort = new AbortController();
    const stopWatchingCancellation = watchForCancellation(
      this.scanState,
      scanJobId,
      abort,
    );

    try {
      await this.scanState.assertOwned(workspaceId, scanJobId);
      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.completeAnalysisUnit(scanJobId, {
          failed: false,
          githubId,
        });
        return;
      }
      if (await this.scanState.isTerminal(scanJobId)) {
        return;
      }

      const work = async () => {
        const [owner, name] = fullName.split('/');
        const fetched = await this.pipeline.fetchRepositoryContext(
          {
            id: githubId,
            full_name: fullName,
            html_url: `https://github.com/${fullName}`,
            description: null,
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: null,
            topics: [],
            created_at: new Date().toISOString(),
            pushed_at: new Date().toISOString(),
            owner: { login: owner },
            name,
          },
          brands,
          { workspaceId, scanJobId, signal: abort.signal },
          { branch },
        );

        await this.github.clearScanPause(scanJobId);

        const result = await this.pipeline.runDetectionAndPersist({
          workspaceId,
          scanJobId,
          repositoryDbId,
          githubId,
          fullName,
          ctx: fetched.ctx,
          brandId: fetched.ctx.matchedBrandId,
          brandName: fetched.ctx.matchedBrandName,
          branch,
        });

        // This repo has now genuinely been analyzed (a real clone+scan just
        // ran against it), even though only one specific branch - it must
        // no longer look like an untouched discovery candidate, or
        // FindingsService.list() will silently exclude everything just
        // created above (it unconditionally hides findings whose repo is
        // still pendingAnalysis=true). Deliberately the ONLY Repository
        // field this processor ever writes - see clearPendingAnalysis's own
        // doc comment for why nothing else (defaultBranch, lastScannedAt,
        // stars/forks/description, ...) is touched here.
        await this.pipeline.clearPendingAnalysis(workspaceId, repositoryDbId);

        const isHighImpact =
          result.severity === Severity.CRITICAL ||
          result.severity === Severity.HIGH;

        await this.scanState.completeAnalysisUnit(scanJobId, {
          findingsCreated: result.created,
          findingsUpdated: result.updated,
          findingsNew: result.findingsNew,
          findingsUnchanged: result.findingsUnchanged,
          findingsReopened: result.findingsReopened,
          findingsResolved: result.findingsResolved,
          findingsHighRisk: isHighImpact && result.findingId ? 1 : 0,
          githubId,
        });
      };

      await withJobTimeout(
        work(),
        timeoutMs,
        `Branch analysis timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      abort.abort();
      if (
        error instanceof DelayedError ||
        (error as Error)?.name === 'DelayedError'
      ) {
        throw error;
      }
      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.completeAnalysisUnit(scanJobId, {
          failed: false,
          githubId,
        });
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
      this.logger.warn(
        `Branch analysis failed ${fullName}@${branch}: ${safeJobError(error)}`,
      );
      if (isFinalAttempt(job)) {
        await this.scanState.markFailed(scanJobId, error);
      }
      throw error;
    } finally {
      stopWatchingCancellation();
    }
  }
}
