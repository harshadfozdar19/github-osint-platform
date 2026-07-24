import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
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
  QUEUE_DETECTION_PROCESSING,
  QUEUE_GITHUB_SEARCH,
  QUEUE_REPOSITORY_ANALYSIS,
  QUEUE_SCAN_ORCHESTRATOR,
  AlertDispatchJobData,
  DetectionProcessingJobData,
  GitHubSearchJobData,
  RepositoryAnalysisJobData,
  ScanOrchestratorJobData,
  alertJobId,
  detectionJobId,
  githubSearchJobId,
  orchestratorJobId,
  repoAnalysisJobId,
} from './queue.constants';
import { buildScanConfigHash, defaultJobOptions } from './queue.utils';
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
  /** User-requested repo discovery cap; clamped to the admin ceiling. */
  maxRepos?: number;
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
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
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
    const adminMaxRepos = Number(
      this.config.get('MAX_REPOSITORIES') ||
        this.config.get('SCAN_MAX_REPOS') ||
        1000,
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
        .select('_id')
        .lean()
        .exec();
      if (!brand) throw new NotFoundException('Brand not found');
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
        ? `brand:${scopeBrandId}`
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
        ? `one brand`
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
      maxRepos,
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
    return this.searchQueue.add('search', data, {
      ...defaultJobOptions(priority),
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

  async cancelScan(workspaceId: string, scanJobId: string) {
    const job = await this.scanState.requestCancel(workspaceId, scanJobId);
    // Best-effort removal of waiting child jobs
    const patterns = [orchestratorJobId(scanJobId)];
    for (const queueName of ALL_SCAN_QUEUES) {
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
    }
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
      default:
        throw new NotFoundException(`Unknown queue ${name}`);
    }
  }
}
