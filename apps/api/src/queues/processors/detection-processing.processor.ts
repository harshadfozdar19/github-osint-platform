import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import {
  QUEUE_DETECTION_PROCESSING,
  DetectionProcessingJobData,
} from '../queue.constants';
import { ScanQueueService } from '../scan-queue.service';
import { ScanStateService } from '../../scans/scan-state.service';
import { ScanPipelineService } from '../../scans/scan-pipeline.service';
import { DiscoveryExpansionService } from '../../scans/discovery-expansion.service';
import { RepoAnalysisContext } from '../../detection/rules/rule.types';
import { Severity } from '../../common/enums';
import {
  safeJobError,
  isFinalAttempt,
  withJobTimeout,
  sharedWorkerTuning,
} from '../queue.utils';

@Processor(QUEUE_DETECTION_PROCESSING, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_DETECTION || 3),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
  ...sharedWorkerTuning(),
})
export class DetectionProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(DetectionProcessingProcessor.name);

  constructor(
    private readonly scanQueue: ScanQueueService,
    private readonly scanState: ScanStateService,
    private readonly pipeline: ScanPipelineService,
    private readonly expansion: DiscoveryExpansionService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<DetectionProcessingJobData>): Promise<void> {
    const data = job.data;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );

    try {
      await this.scanState.assertOwned(data.workspaceId, data.scanJobId);
      if (await this.scanState.isCancelled(data.scanJobId)) {
        await this.scanState.completeAnalysisUnit(data.scanJobId, {
          failed: false,
          githubId: data.githubId,
        });
        return;
      }

      const work = async () => {
        const ctx: RepoAnalysisContext = {
          fullName: data.ctx.fullName,
          owner: data.ctx.owner,
          name: data.ctx.name,
          description: data.ctx.description,
          topics: data.ctx.topics,
          language: data.ctx.language,
          stars: data.ctx.stars,
          forks: data.ctx.forks,
          isFork: data.ctx.isFork,
          githubCreatedAt: data.ctx.githubCreatedAt
            ? new Date(data.ctx.githubCreatedAt)
            : undefined,
          githubPushedAt: data.ctx.githubPushedAt
            ? new Date(data.ctx.githubPushedAt)
            : undefined,
          ownerAccountCreatedAt: data.ctx.ownerAccountCreatedAt
            ? new Date(data.ctx.ownerAccountCreatedAt)
            : undefined,
          ownerFollowers: data.ctx.ownerFollowers,
          ownerPublicRepos: data.ctx.ownerPublicRepos,
          filePaths: data.ctx.filePaths,
          readmeText: data.ctx.readmeText,
          readmePath: data.ctx.readmePath,
          smallFileTexts: data.ctx.smallFileTexts,
          brandFileMatches: data.ctx.brandFileMatches,
          keywordFileMatches: data.ctx.keywordFileMatches,
          fullRepoSecretCandidates: data.ctx.fullRepoSecretCandidates,
          matchedBrandId: data.ctx.matchedBrandId,
          matchedBrandName: data.ctx.matchedBrandName,
          matchedBrandAliases: data.ctx.matchedBrandAliases,
          matchedBrandTrustedOwners: data.ctx.matchedBrandTrustedOwners,
          matchedBrandKeywords: data.ctx.matchedBrandKeywords,
          commitMessages: data.ctx.commitMessages,
          commitAuthors: data.ctx.commitAuthors,
        };

        const result = await this.pipeline.runDetectionAndPersist({
          workspaceId: data.workspaceId,
          scanJobId: data.scanJobId,
          repositoryDbId: data.repositoryDbId,
          githubId: data.githubId,
          fullName: data.fullName,
          ctx,
          brandId: data.ctx.matchedBrandId,
          brandName: data.ctx.matchedBrandName,
          internalAudit: data.internalAudit,
        });

        await this.pipeline.upsertRepository(
          data.workspaceId,
          {
            id: data.githubId,
            full_name: data.fullName,
            html_url: `https://github.com/${data.fullName}`,
            description: data.ctx.description,
            stargazers_count: data.ctx.stars,
            forks_count: data.ctx.forks,
            fork: data.ctx.isFork,
            language: data.ctx.language,
            topics: data.ctx.topics,
            created_at: data.ctx.githubCreatedAt || new Date().toISOString(),
            pushed_at: data.ctx.githubPushedAt || new Date().toISOString(),
            owner: { login: data.ctx.owner },
            name: data.ctx.name,
            default_branch: data.defaultBranch,
          },
          {
            defaultBranch: data.defaultBranch,
            commitSha: data.commitSha,
            contentEtag: data.contentEtag,
            rulesetVersion: data.rulesetVersion,
            scanJobId: data.scanJobId,
            markSuccess: true,
            internalAudit: data.internalAudit,
          },
        );

        // Expand coverage from Critical/High hits before completing the unit
        // so awaitingAnalysis includes the new child jobs.
        const isHighImpact =
          result.severity === Severity.CRITICAL ||
          result.severity === Severity.HIGH;
        if (
          isHighImpact &&
          result.findingId &&
          (await this.scanState.isCancelled(data.scanJobId)) === false
        ) {
          await this.expansion.expandFromFinding({
            workspaceId: data.workspaceId,
            scanJobId: data.scanJobId,
            owner: data.ctx.owner,
            fullName: data.fullName,
            githubId: data.githubId,
            rulesetVersion: data.rulesetVersion,
          });
          await this.expansion.promoteKeywordsFromFinding(
            data.workspaceId,
            `${data.fullName} ${data.ctx.description} ${data.ctx.topics.join(' ')}`,
          );
        }

        await this.scanState.completeAnalysisUnit(data.scanJobId, {
          findingsCreated: result.created,
          findingsUpdated: result.updated,
          findingsNew: result.findingsNew,
          findingsUnchanged: result.findingsUnchanged,
          findingsReopened: result.findingsReopened,
          findingsResolved: result.findingsResolved,
          // isHighImpact already answers "is this repo's finding severe
          // enough to matter" (used just above to decide fan-out expansion)
          // - reuse it here as the "actually a real threat" tally rather
          // than recomputing the same check.
          findingsHighRisk: isHighImpact && result.findingId ? 1 : 0,
          rescanned: true,
          resumed: data.resumed === true,
          githubId: data.githubId,
        });

        if (result.shouldAlert && result.findingId) {
          await this.scanQueue.enqueueAlert({
            workspaceId: data.workspaceId,
            scanJobId: data.scanJobId,
            findingId: result.findingId,
          });
        }
      };

      await withJobTimeout(
        work(),
        timeoutMs,
        `Detection timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      this.logger.warn(
        `Detection failed for ${data.fullName}: ${safeJobError(error)}`,
      );
      if (isFinalAttempt(job)) {
        await this.pipeline.upsertRepository(
          data.workspaceId,
          {
            id: data.githubId,
            full_name: data.fullName,
            html_url: `https://github.com/${data.fullName}`,
            description: data.ctx.description,
            stargazers_count: data.ctx.stars,
            forks_count: data.ctx.forks,
            fork: data.ctx.isFork,
            language: data.ctx.language,
            topics: data.ctx.topics,
            created_at: data.ctx.githubCreatedAt || new Date().toISOString(),
            pushed_at: data.ctx.githubPushedAt || new Date().toISOString(),
            owner: { login: data.ctx.owner },
            name: data.ctx.name,
          },
          {
            scanJobId: data.scanJobId,
            markFailed: true,
            internalAudit: data.internalAudit,
          },
        );
        await this.scanState.completeAnalysisUnit(data.scanJobId, {
          failed: true,
          failedKey: `${data.githubId}:${data.fullName}`,
          githubId: data.githubId,
        });
      }
      throw error;
    }
  }
}
