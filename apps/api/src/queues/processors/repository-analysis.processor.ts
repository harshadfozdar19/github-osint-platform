import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import { Types } from 'mongoose';
import {
  QUEUE_REPOSITORY_ANALYSIS,
  RepositoryAnalysisJobData,
} from '../queue.constants';
import { ScanQueueService } from '../scan-queue.service';
import { ScanStateService } from '../../scans/scan-state.service';
import { ScanPipelineService } from '../../scans/scan-pipeline.service';
import { IncrementalScanService } from '../../scans/incremental-scan.service';
import { GitHubService } from '../../github/github.service';
import { CloneScanService } from '../../scans/clone-scan.service';
import {
  safeJobError,
  isFinalAttempt,
  withJobTimeout,
  sharedWorkerTuning,
  watchForCancellation,
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
    private readonly cloneScan: CloneScanService,
  ) {
    super();
  }

  async process(job: Job<RepositoryAnalysisJobData>): Promise<void> {
    const { workspaceId, scanJobId, repo, brands, internalAudit } = job.data;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );
    let detectionEnqueued = false;
    const abort = new AbortController();
    // Same rationale as GitHubSearchProcessor: a fetch here can end up
    // sleeping through a multi-minute GitHub-imposed rate-limit wait -
    // without this, cancelling the scan mid-wait wouldn't free this worker
    // slot until the wait ran out on its own.
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
          githubId: repo.id,
        });
        return;
      }
      if (await this.scanState.isTerminal(scanJobId)) {
        // debug, not log - expected and harmless (jobs that were already
        // in-flight when the scan finalized/got cancelled drain out this
        // way one at a time), but at 'log' level a scan with a large
        // backlog floods the console with hundreds of identical lines.
        // main.ts's configured logger levels (['log','error','warn']) drop
        // debug entirely, so this is silent by default.
        this.logger.debug(
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
        // For clone-eligible repos, get it over git's own transport instead
        // of GitHub REST (getRepositoryHead is actually two REST calls) -
        // zero GitHub quota and zero Redis rate-limit bookkeeping. Falls
        // back to REST for anything not clone-eligible or if git fails.
        const [owner, name] = repo.full_name.split('/');
        const remoteHead = (await this.cloneScan.shouldAttempt(repo.size))
          ? await this.cloneScan.getRemoteHead(owner, name)
          : null;
        const head = remoteHead
          ? {
              sha: remoteHead.sha,
              defaultBranch: remoteHead.defaultBranch || repo.default_branch,
              pushedAt: undefined,
              updatedAt: undefined,
              etag: undefined,
            }
          : await this.github.getRepositoryHead(owner, name, {
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
            internalAudit,
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
            internalAudit,
          },
        );
        const fetched = await this.pipeline.fetchRepositoryContext(
          repo,
          brands,
          { workspaceId, scanJobId, signal: abort.signal },
          { commitSha: head?.sha || decision.commitSha },
        );

        // Deployment/contributor enrichment comes straight from GitHub REST
        // (no clone needed) and isn't part of detection - best-effort only,
        // a failure here shouldn't fail the whole analysis pass.
        try {
          const [deployment, contributors] = await Promise.all([
            this.github.getLatestDeployment(owner, name, {
              workspaceId,
              scanJobId,
              signal: abort.signal,
            }),
            this.github.listContributors(owner, name, {
              workspaceId,
              scanJobId,
              signal: abort.signal,
            }),
          ]);
          await this.pipeline.persistDeploymentAndContributors(
            new Types.ObjectId(workspaceId),
            upserted._id,
            owner,
            repo.full_name,
            deployment
              ? {
                  ...deployment,
                  updatedAt: deployment.updatedAt
                    ? new Date(deployment.updatedAt)
                    : undefined,
                }
              : null,
            contributors,
          );
        } catch (enrichError) {
          this.logger.warn(
            `Deployment/contributor enrichment failed for ${repo.full_name}: ${safeJobError(enrichError)}`,
          );
        }

        // Git-history scan is opt-in and costs extra GitHub requests per repo
        // (a commits list + one call per commit), so it's bounded to repos
        // that already matched a monitored brand rather than every discovery.
        // The match is now decided post-fetch (fetchRepositoryContext greps
        // the whole repo against every brand), not from a pre-clone hint.
        const historySha = head?.sha || decision.commitSha;
        if (
          fetched.ctx.matchedBrandName &&
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
            internalAudit,
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
              ownerAccountCreatedAt:
                fetched.ctx.ownerAccountCreatedAt?.toISOString(),
              ownerFollowers: fetched.ctx.ownerFollowers,
              ownerPublicRepos: fetched.ctx.ownerPublicRepos,
              filePaths: fetched.ctx.filePaths,
              readmeText: fetched.ctx.readmeText,
              readmePath: fetched.ctx.readmePath,
              smallFileTexts: fetched.ctx.smallFileTexts,
              brandFileMatches: fetched.ctx.brandFileMatches,
              keywordFileMatches: fetched.ctx.keywordFileMatches,
              fullRepoSecretCandidates: fetched.ctx.fullRepoSecretCandidates,
              matchedBrandId: fetched.ctx.matchedBrandId,
              matchedBrandName: fetched.ctx.matchedBrandName,
              matchedBrandAliases: fetched.ctx.matchedBrandAliases,
              matchedBrandTrustedOwners: fetched.ctx.matchedBrandTrustedOwners,
              matchedBrandKeywords: fetched.ctx.matchedBrandKeywords,
              commitMessages: fetched.ctx.commitMessages,
              commitAuthors: fetched.ctx.commitAuthors,
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
      // The cancellation watcher above is what aborted us (mid-wait or
      // mid-request) - a clean, intentional stop, not a failure worth
      // logging, retrying, or marking this repo as failed.
      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.completeAnalysisUnit(scanJobId, {
          failed: false,
          githubId: repo.id,
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
        `Repo analysis failed ${repo.full_name}: ${safeJobError(error)}`,
      );
      if (!detectionEnqueued && isFinalAttempt(job)) {
        await this.pipeline.upsertRepository(workspaceId, repo, {
          scanJobId,
          markFailed: true,
          internalAudit,
        });
        await this.scanState.completeAnalysisUnit(scanJobId, {
          failed: true,
          failedKey: `${repo.id}:${repo.full_name}`,
          githubId: repo.id,
        });
      }
      throw error;
    } finally {
      stopWatchingCancellation();
    }
  }
}
