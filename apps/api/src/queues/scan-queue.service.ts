import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  ScanCheckpointStage,
  ScanJobStatus,
  ScanJobType,
  ScanMode,
} from '../common/enums';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../brands/schemas/monitored-brand.schema';
import { ScanJob, ScanJobDocument } from '../scans/schemas/scan-job.schema';
import {
  ALL_SCAN_QUEUES,
  QUEUE_ALERT_DISPATCH,
  QUEUE_BRANCH_ANALYSIS,
  QUEUE_DETECTION_PROCESSING,
  QUEUE_GITHUB_SEARCH,
  QUEUE_INTENT_ASSESSMENT,
  QUEUE_REPOSITORY_ANALYSIS,
  QUEUE_SCAN_ORCHESTRATOR,
  AlertDispatchJobData,
  BranchAnalysisJobData,
  DetectionProcessingJobData,
  GitHubSearchJobData,
  IntentAssessmentJobData,
  RepositoryAnalysisJobData,
  ScanOrchestratorJobData,
  alertJobId,
  branchAnalysisJobId,
  detectionJobId,
  githubSearchJobId,
  intentAssessmentJobId,
  orchestratorJobId,
  repoAnalysisJobId,
} from './queue.constants';
import { buildScanConfigHash, defaultJobOptions } from './queue.utils';
import {
  buildCreatedQualifier,
  buildPushedQualifier,
} from '../scans/discovery/query-families';
import { ScanStateService } from '../scans/scan-state.service';
import { ScanProgressService } from '../scans/progress/scan-progress.service';
import {
  ScanProgressEventType,
  ScanProgressPhase,
} from '../scans/progress/scan-progress.types';
import { DetectionEngine } from '../detection/detection.engine';

export interface ManualScanOptions {
  mode?: ScanMode;
  forceFullScan?: boolean;
  force?: boolean;
  /** Scope to a single monitored brand instead of sweeping all enabled brands. */
  brandId?: string;
  /** Scope to one raw GitHub search query. Takes priority over brandId. */
  customQuery?: string;
  searchKind?: 'repositories' | 'code';
  /** Internal audit: enumerate the scoped brand's own trustedGithubOwners repos instead of searching for mentions. Requires brandId. */
  internalAudit?: boolean;
  /** User-requested repo discovery cap; clamped to the admin ceiling. */
  maxRepos?: number;
  /** Only consider repos created on/after this date (YYYY-MM-DD). */
  createdFrom?: string;
  /** Only consider repos created on/before this date (YYYY-MM-DD). */
  createdTo?: string;
  /** Only consider repos last pushed to on/after this date (YYYY-MM-DD) - filters by recent activity, independent of createdFrom/createdTo. */
  pushedFrom?: string;
  /** Only consider repos last pushed to on/before this date (YYYY-MM-DD). */
  pushedTo?: string;
  /** 'or' matches repos satisfying EITHER the created OR pushed range instead of requiring both ('and', default) - only meaningful when both are set. */
  dateFilterMode?: 'and' | 'or';
  /** mode=analyze_pending only: only analyze pending repos this workspace discovered on/after this date (YYYY-MM-DD) - Repository.createdAt, not any GitHub timestamp. Ignored for every other mode. */
  discoveredFrom?: string;
  /** mode=analyze_pending only: only analyze pending repos this workspace discovered on/before this date (YYYY-MM-DD). Ignored for every other mode. */
  discoveredTo?: string;
  /** Resume each search query from this workspace's last discovery cursor instead of starting every scan at page 1. */
  continueDiscovery?: boolean;
  /**
   * Discover and save candidate repos (metadata only) without running
   * content analysis on any of them - maximize discovery coverage now,
   * decide what's worth actually analyzing later via
   * ScanMode.ANALYZE_PENDING. Ignored for internalAudit and for
   * failed_only/analyze_pending, which are inherently analysis-only.
   */
  discoveryOnly?: boolean;
  /**
   * Scope this scan to exactly ONE of the brand's own custom keywords -
   * just that keyword's repo-search + code-search query pair, skipping
   * phishing/apk/impersonation/typo-squat/trusted-account and every other
   * keyword. Requires brandId; mutually exclusive with customQuery and
   * internalAudit. Multiple keyword-scoped scans for the SAME brand can be
   * active at once (each gets its own configHash bucket), which is the
   * point - the per-keyword start/stop toggle on the Brands page runs
   * several keywords concurrently, independently.
   */
  keyword?: string;
  /** User-edited override for keyword's auto-generated repo-search query - used verbatim. Requires keyword. */
  customRepoQuery?: string;
  /** User-edited override for keyword's auto-generated code-search query - used verbatim. Requires keyword. */
  customCodeQuery?: string;
  /**
   * Restricts keyword's auto-generated query pair to just repo search or
   * just code search instead of both (default 'both' when unset). Requires
   * keyword. Lets the caller deliberately pick which GitHub search index
   * this scan spends its time on - e.g. skip code search's much tighter
   * 10/min ceiling entirely rather than waiting it out.
   */
  searchScope?: 'both' | 'repositories' | 'code';
  /**
   * Delay (ms) before the orchestrator actually starts this scan - the
   * persisted ScanJob is still created and visible (status QUEUED)
   * immediately, only the real GitHub work is deferred. Used by
   * ScanStateService's keyword-watch auto-restart to space out repeat runs
   * of the same keyword instead of re-searching the instant the previous
   * run exhausts its results.
   */
  delayMs?: number;
  /** Internal: set by KeywordRotationService for a rotation-driven scan - see ScanJob.rotationManaged. Not settable from the public API. */
  rotationManaged?: boolean;
}

@Injectable()
export class ScanQueueService {
  private readonly logger = new Logger(ScanQueueService.name);

  constructor(
    @InjectQueue(QUEUE_SCAN_ORCHESTRATOR)
    private readonly orchestratorQueue: Queue<ScanOrchestratorJobData>,
    @InjectQueue(QUEUE_GITHUB_SEARCH)
    private readonly searchQueue: Queue<GitHubSearchJobData>,
    @InjectQueue(QUEUE_REPOSITORY_ANALYSIS)
    private readonly analysisQueue: Queue<RepositoryAnalysisJobData>,
    @InjectQueue(QUEUE_DETECTION_PROCESSING)
    private readonly detectionQueue: Queue<DetectionProcessingJobData>,
    @InjectQueue(QUEUE_ALERT_DISPATCH)
    private readonly alertQueue: Queue<AlertDispatchJobData>,
    @InjectQueue(QUEUE_BRANCH_ANALYSIS)
    private readonly branchAnalysisQueue: Queue<BranchAnalysisJobData>,
    @InjectQueue(QUEUE_INTENT_ASSESSMENT)
    private readonly intentAssessmentQueue: Queue<IntentAssessmentJobData>,
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    @Inject(forwardRef(() => ScanStateService))
    private readonly scanState: ScanStateService,
    private readonly progress: ScanProgressService,
    private readonly config: ConfigService,
    private readonly detectionEngine: DetectionEngine,
  ) {}

  /**
   * Persist a queued scan and enqueue the orchestrator job.
   * Returns immediately — does not run GitHub work in-process.
   */
  async enqueueManualScan(
    workspaceId: string,
    userId: string,
    options: ManualScanOptions = {},
  ) {
    const mode = options.mode || ScanMode.INCREMENTAL;
    const forceFullScan =
      options.forceFullScan === true || mode === ScanMode.FULL;
    const rulesetVersion = this.detectionEngine.getRulesetVersion();
    // Unbounded by default (MAX_SAFE_INTEGER, not a realistic ceiling any
    // scan will ever reach) - only MAX_REPOSITORIES/SCAN_MAX_REPOS being set
    // actually imposes a cap. GitHub's own per-query 1000-result ceiling and
    // rate limits are the real, unavoidable bound in practice; this is just
    // an optional extra one for whoever wants to cost-cap deliberately.
    const adminMaxRepos = Number(
      this.config.get('MAX_REPOSITORIES') ||
        this.config.get('SCAN_MAX_REPOS') ||
        Number.MAX_SAFE_INTEGER,
    );
    // A user can ask for fewer repos (a quick pass) but never more than the
    // admin-configured ceiling — that ceiling exists to bound GitHub quota
    // and cost, and a per-scan request must not be able to exceed it.
    const maxRepos = options.maxRepos
      ? Math.max(1, Math.min(Math.trunc(options.maxRepos), adminMaxRepos))
      : adminMaxRepos;

    // customQuery takes priority over brandId when both are set.
    const customQuery = options.customQuery?.trim() || undefined;
    const searchKind = options.searchKind || 'repositories';
    if (
      customQuery &&
      searchKind === 'code' &&
      (options.createdFrom ||
        options.createdTo ||
        options.pushedFrom ||
        options.pushedTo)
    ) {
      throw new BadRequestException(
        'createdFrom/createdTo/pushedFrom/pushedTo only apply to repository search, not code search',
      );
    }
    // Validates format/range/bounds up front so a bad date fails the request
    // immediately instead of surfacing deep inside the orchestrator later.
    buildCreatedQualifier(options.createdFrom, options.createdTo);
    buildPushedQualifier(options.pushedFrom, options.pushedTo);
    const internalAudit = options.internalAudit === true && !customQuery;
    if (options.internalAudit === true && customQuery) {
      throw new BadRequestException(
        'internalAudit cannot be combined with customQuery',
      );
    }
    if (internalAudit && !options.brandId) {
      throw new BadRequestException(
        "internalAudit requires brandId - it audits one specific brand's own trusted GitHub accounts",
      );
    }
    const keyword = options.keyword?.trim() || undefined;
    if (keyword && customQuery) {
      throw new BadRequestException(
        'keyword cannot be combined with customQuery',
      );
    }
    if (keyword && options.internalAudit === true) {
      throw new BadRequestException(
        'keyword cannot be combined with internalAudit',
      );
    }
    if (keyword && !options.brandId) {
      throw new BadRequestException(
        "keyword requires brandId - it scopes the scan to one of that brand's own custom keywords",
      );
    }
    const customRepoQuery = options.customRepoQuery?.trim() || undefined;
    const customCodeQuery = options.customCodeQuery?.trim() || undefined;
    if ((customRepoQuery || customCodeQuery) && !keyword) {
      throw new BadRequestException(
        "customRepoQuery/customCodeQuery require keyword - they override that one keyword's auto-generated queries",
      );
    }
    if (options.searchScope && options.searchScope !== 'both' && !keyword) {
      throw new BadRequestException(
        'searchScope only applies to a keyword-scoped scan',
      );
    }

    let scopeBrandId: string | undefined;
    if (!customQuery && options.brandId) {
      if (!Types.ObjectId.isValid(options.brandId)) {
        throw new NotFoundException('Brand not found');
      }
      const brand = await this.brandModel
        .findOne({
          _id: options.brandId,
          workspaceId: new Types.ObjectId(workspaceId),
        })
        .select('_id trustedGithubOwners')
        .lean()
        .exec();
      if (!brand) throw new NotFoundException('Brand not found');
      if (internalAudit && (brand.trustedGithubOwners || []).length === 0) {
        throw new BadRequestException(
          'This brand has no trustedGithubOwners configured - add its own GitHub org/user account(s) to the brand first',
        );
      }
      scopeBrandId = options.brandId;
    }

    const brands = await this.brandModel
      .find({ workspaceId: new Types.ObjectId(workspaceId), enabled: true })
      .select('_id')
      .lean()
      .exec();
    const scope = customQuery
      ? `query:${searchKind}:${customQuery}`
      : scopeBrandId
        ? internalAudit
          ? `internal-audit:${scopeBrandId}`
          : keyword
            ? `keyword:${scopeBrandId}:${keyword}`
            : `brand:${scopeBrandId}`
        : undefined;
    const configHash = buildScanConfigHash({
      workspaceId,
      brandIds: brands.map((b) => String(b._id)),
      maxRepos,
      scope,
    });

    const duplicate = await this.scanState.findActiveDuplicate(
      workspaceId,
      configHash,
    );
    if (duplicate) {
      if (options.force) {
        // Cancel the existing active scan before proceeding
        await this.cancelScan(workspaceId, String(duplicate._id));
      } else {
        throw new ConflictException({
          message:
            'An active scan already exists for this workspace and configuration',
          existingScanId: String(duplicate._id),
          status: duplicate.status,
        });
      }
    }

    const scopeLabel = customQuery
      ? `custom query`
      : scopeBrandId
        ? internalAudit
          ? `internal audit of one brand's own repos`
          : keyword
            ? `keyword "${keyword}"`
            : `one brand`
        : undefined;
    const queuedMessage = scopeLabel
      ? `Scan queued (${mode}, scoped to ${scopeLabel})`
      : `Scan queued (${mode})`;

    const idempotencyKey = `manual:${workspaceId}:${configHash}:${mode}:${randomUUID()}`;
    const job = await this.scanModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      type: ScanJobType.MANUAL,
      mode,
      forceFullScan,
      rulesetVersion,
      status: ScanJobStatus.QUEUED,
      triggeredBy: new Types.ObjectId(userId),
      configHash,
      idempotencyKey,
      priority: 3,
      cancelRequested: false,
      message: queuedMessage,
      scopeBrandId: scopeBrandId ? new Types.ObjectId(scopeBrandId) : undefined,
      scopeQuery: customQuery,
      scopeSearchKind: customQuery ? searchKind : undefined,
      scopeKeyword: keyword,
      customRepoQuery,
      customCodeQuery,
      searchScope: keyword ? options.searchScope : undefined,
      internalAudit,
      rotationManaged: options.rotationManaged === true,
      discoveryOnly: options.discoveryOnly === true && !internalAudit,
      scheduledFor:
        options.delayMs && options.delayMs > 0
          ? new Date(Date.now() + options.delayMs)
          : undefined,
      maxRepos,
      createdFrom: options.createdFrom
        ? new Date(options.createdFrom)
        : undefined,
      createdTo: options.createdTo ? new Date(options.createdTo) : undefined,
      pushedFrom: options.pushedFrom ? new Date(options.pushedFrom) : undefined,
      pushedTo: options.pushedTo ? new Date(options.pushedTo) : undefined,
      dateFilterMode: options.dateFilterMode === 'or' ? 'or' : 'and',
      discoveredFrom:
        (mode === ScanMode.ANALYZE_PENDING ||
          mode === ScanMode.REANALYZE_EXISTING) &&
        options.discoveredFrom
          ? new Date(options.discoveredFrom)
          : undefined,
      discoveredTo:
        (mode === ScanMode.ANALYZE_PENDING ||
          mode === ScanMode.REANALYZE_EXISTING) &&
        options.discoveredTo
          ? new Date(options.discoveredTo)
          : undefined,
      continueDiscovery: options.continueDiscovery === true,
      checkpoint: {
        stage: ScanCheckpointStage.QUEUED,
        updatedAt: new Date(),
        searchCursors: {},
        completedGithubIds: [],
        skippedGithubIds: [],
        failedGithubIds: [],
        pendingGithubIds: [],
      },
    });

    const scanJobId = String(job._id);
    await this.orchestratorQueue.add(
      'orchestrate',
      {
        workspaceId,
        scanJobId,
        type: 'manual',
        triggeredBy: userId,
        configHash,
        mode,
        forceFullScan,
        rulesetVersion,
      },
      {
        ...defaultJobOptions(3),
        jobId: orchestratorJobId(scanJobId),
        ...(options.delayMs && options.delayMs > 0
          ? { delay: options.delayMs }
          : {}),
      },
    );

    this.logger.log(
      `Queued manual scan ${scanJobId} for workspace ${workspaceId} mode=${mode}${scopeLabel ? ` scope=${scopeLabel}` : ''}`,
    );
    await this.progress.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.QUEUED,
      phase: ScanProgressPhase.QUEUED,
      status: ScanJobStatus.QUEUED,
      message: queuedMessage,
      force: true,
      percent: 0,
    });
    return job.toObject();
  }

  async enqueueGithubSearch(data: GitHubSearchJobData, priority = 5) {
    const page = data.page || 1;
    const searchKind = data.searchKind || 'repositories';
    // Code search's real GitHub ceiling (10/min) is far tighter than repo
    // search's (30/min) or core's (5000/hr) - a code-search job sitting
    // behind an exhausted budget makes zero progress when a worker picks
    // it up (see paceRequest/enforcePauseAndQuota), while a ready
    // repo-search job usually can. When both kinds are waiting in the
    // queue at once, let repo-search jobs be pulled by a free worker
    // first - lower BullMQ priority number = processed first, so code
    // search gets nudged one tier behind, not blocked outright: with 8
    // concurrent workers both kinds still run side by side whenever
    // there's no contention, this only breaks ties under pressure, which
    // is exactly when it matters.
    const effectivePriority = searchKind === 'code' ? priority + 1 : priority;
    return this.searchQueue.add('search', data, {
      ...defaultJobOptions(effectivePriority),
      jobId: githubSearchJobId(
        data.scanJobId,
        data.queryIndex,
        page,
        searchKind,
      ),
    });
  }

  async enqueueRepositoryAnalysis(
    data: RepositoryAnalysisJobData,
    priority = 5,
  ) {
    return this.analysisQueue.add('analyze', data, {
      ...defaultJobOptions(priority),
      jobId: repoAnalysisJobId(data.scanJobId, data.repo.id),
    });
  }

  /**
   * Bulk equivalent of enqueueRepositoryAnalysis - one Redis round-trip for
   * the whole batch (BullMQ's addBulk) instead of one per repo. Exists for
   * ANALYZE_PENDING/FAILED_ONLY, which can hand off thousands of repos to
   * the analysis queue in a single orchestrator run - at that volume,
   * enqueueing one job at a time is itself slow enough to dominate the
   * orchestrator's own runtime before any worker has even started analyzing
   * anything.
   */
  async enqueueRepositoryAnalysisBulk(
    items: RepositoryAnalysisJobData[],
    priority = 5,
  ) {
    if (items.length === 0) return [];
    return this.analysisQueue.addBulk(
      items.map((data) => ({
        name: 'analyze',
        data,
        opts: {
          ...defaultJobOptions(priority),
          jobId: repoAnalysisJobId(data.scanJobId, data.repo.id),
        },
      })),
    );
  }

  async enqueueDetection(data: DetectionProcessingJobData, priority = 5) {
    return this.detectionQueue.add('detect', data, {
      ...defaultJobOptions(priority),
      jobId: detectionJobId(data.scanJobId, data.githubId),
    });
  }

  async enqueueAlert(data: AlertDispatchJobData, priority = 4) {
    return this.alertQueue.add('alert', data, {
      ...defaultJobOptions(priority),
      jobId: alertJobId(data.scanJobId, data.findingId),
    });
  }

  async enqueueIntentAssessment(data: IntentAssessmentJobData, priority = 6) {
    return this.intentAssessmentQueue.add('assess', data, {
      ...defaultJobOptions(priority),
      jobId: intentAssessmentJobId(data.findingId),
    });
  }

  /**
   * Creates and starts a ScanMode.BRANCH_ANALYSIS scan for one already-known
   * repository's one specific branch - see ScanMode.BRANCH_ANALYSIS and
   * BranchAnalysisProcessor. Unlike enqueueManualScan, this skips the
   * orchestrator/discovery phase entirely (the repo and branch are already
   * fully known - there's nothing to discover) and goes straight to
   * running: creates the ScanJob already at reposTotal=1/
   * awaitingAnalysis=1, marks it RUNNING immediately, and enqueues the one
   * analysis unit directly.
   */
  async startBranchAnalysis(
    workspaceId: string,
    userId: string,
    repo: {
      repositoryDbId: string;
      githubId: number;
      fullName: string;
    },
    brands: BranchAnalysisJobData['brands'],
    branch: string,
  ) {
    const job = await this.scanModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      type: ScanJobType.MANUAL,
      mode: ScanMode.BRANCH_ANALYSIS,
      status: ScanJobStatus.QUEUED,
      triggeredBy: new Types.ObjectId(userId),
      idempotencyKey: `branch-analysis:${workspaceId}:${repo.repositoryDbId}:${branch}:${randomUUID()}`,
      priority: 3,
      cancelRequested: false,
      message: `Scan queued (branch analysis: ${repo.fullName}@${branch})`,
      scopeRepositoryId: new Types.ObjectId(repo.repositoryDbId),
      scopeBranch: branch,
      reposTotal: 1,
      awaitingAnalysis: 1,
      checkpoint: {
        stage: ScanCheckpointStage.ANALYSIS,
        updatedAt: new Date(),
        searchCursors: {},
        completedGithubIds: [],
        skippedGithubIds: [],
        failedGithubIds: [],
        pendingGithubIds: [repo.githubId],
      },
    });

    const scanJobId = String(job._id);
    await this.progress.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.QUEUED,
      phase: ScanProgressPhase.QUEUED,
      status: ScanJobStatus.QUEUED,
      message: job.message,
      force: true,
      percent: 0,
    });
    await this.scanState.markRunning(scanJobId);

    await this.branchAnalysisQueue.add(
      'analyze',
      {
        workspaceId,
        scanJobId,
        repositoryDbId: repo.repositoryDbId,
        githubId: repo.githubId,
        fullName: repo.fullName,
        branch,
        brands,
      },
      {
        ...defaultJobOptions(3),
        jobId: branchAnalysisJobId(scanJobId),
      },
    );

    this.logger.log(
      `Queued branch analysis ${scanJobId} for workspace ${workspaceId}: ${repo.fullName}@${branch}`,
    );
    return job.toObject();
  }

  async cancelScan(workspaceId: string, scanJobId: string) {
    const job = await this.scanState.requestCancel(workspaceId, scanJobId);
    // Fire-and-forget, NOT awaited - see sweepQueuedJobsForScan's own
    // comment for why. The caller only needs requestCancel (sets
    // cancelRequested, which every worker checks cooperatively) and
    // finalize (marks the scan row terminal in Mongo) to have actually
    // happened before it returns; the queue sweep is pure best-effort
    // tidiness layered on top.
    void this.sweepQueuedJobsForScan(scanJobId);
    // Finalize the scan immediately so it doesn't get stuck in running
    const finalized = await this.scanState.finalize(scanJobId);
    return finalized
      ? finalized.toObject
        ? finalized.toObject()
        : finalized
      : job.toObject
        ? job.toObject()
        : job;
  }

  /**
   * Best-effort removal of this scan's not-yet-started child jobs (waiting
   * or delayed) across every scan queue, so a cancelled scan doesn't leave
   * a pile of jobs that'll just no-op the moment they run. Deliberately
   * NOT awaited by cancelScan: queue.getJobs(['waiting', 'delayed']) with
   * no range fetches EVERY job of those types in EVERY scan queue,
   * workspace-wide - not scoped to this scan - so its cost scales with
   * total queue depth, not with how much this one scan actually queued.
   * A keyword whose discovery fanned out wide (a broad/common term
   * recursively date- or size-split many times - see
   * GitHubSearchProcessor) can leave thousands of delayed jobs sitting in
   * github-search alone; blocking on this sweep before returning used to
   * turn every cancellation - including the sequential scheduler's own
   * keyword handoff, which calls this on every single turn via
   * KeywordRotationService.cancelCurrentSlot - into a stall proportional
   * to that backlog, not to the actual cancel work. Nothing about
   * cancellation's correctness depends on this finishing before the
   * caller sees a response: any job that slips through and runs anyway
   * still no-ops via ScanStateService.isCancelled (e.g.
   * GitHubSearchProcessor.process checks it before doing any real work).
   */
  private async sweepQueuedJobsForScan(scanJobId: string): Promise<void> {
    const patterns = [orchestratorJobId(scanJobId)];
    for (const queueName of ALL_SCAN_QUEUES) {
      try {
        const queue = this.queueByName(queueName);
        const waiting = await queue.getJobs(['waiting', 'delayed']);
        for (const j of waiting) {
          if (
            j.id?.includes(`scan-${scanJobId}-`) ||
            patterns.includes(String(j.id))
          ) {
            await j.remove().catch(() => undefined);
          }
        }
      } catch (err) {
        this.logger.warn(
          `Best-effort queue sweep failed for scan ${scanJobId} on ${queueName} (non-fatal, orphaned jobs will just no-op when they run): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  async retryFailedScan(
    workspaceId: string,
    scanJobId: string,
    userId: string,
  ) {
    const previous = await this.scanState.getOrThrow(workspaceId, scanJobId);
    if (
      previous.status !== ScanJobStatus.FAILED &&
      previous.status !== ScanJobStatus.PARTIALLY_COMPLETED &&
      previous.status !== ScanJobStatus.CANCELLED
    ) {
      throw new ConflictException(
        'Only failed, partial, or cancelled scans can be retried',
      );
    }
    return this.enqueueManualScan(workspaceId, userId, {
      mode: ScanMode.FAILED_ONLY,
    });
  }

  private queueByName(name: string): Queue {
    switch (name) {
      case QUEUE_SCAN_ORCHESTRATOR:
        return this.orchestratorQueue;
      case QUEUE_GITHUB_SEARCH:
        return this.searchQueue;
      case QUEUE_REPOSITORY_ANALYSIS:
        return this.analysisQueue;
      case QUEUE_DETECTION_PROCESSING:
        return this.detectionQueue;
      case QUEUE_ALERT_DISPATCH:
        return this.alertQueue;
      case QUEUE_BRANCH_ANALYSIS:
        return this.branchAnalysisQueue;
      default:
        throw new NotFoundException(`Unknown queue ${name}`);
    }
  }
}
