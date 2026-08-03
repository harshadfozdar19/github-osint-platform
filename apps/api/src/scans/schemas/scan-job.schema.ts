import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  ScanJobStatus,
  ScanJobType,
  ScanMode,
  ScanCheckpointStage,
} from '../../common/enums';

export type ScanJobDocument = HydratedDocument<ScanJob>;

@Schema({ timestamps: true, collection: 'scanjobs' })
export class ScanJob {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ScanJobType,
    index: true,
  })
  type!: ScanJobType;

  @Prop({
    type: String,
    enum: ScanMode,
    default: ScanMode.INCREMENTAL,
    index: true,
  })
  mode!: ScanMode;

  @Prop({ default: false })
  forceFullScan!: boolean;

  /** Scope this scan to a single monitored brand instead of sweeping all enabled brands */
  @Prop({ type: Types.ObjectId, ref: 'MonitoredBrand' })
  scopeBrandId?: Types.ObjectId;

  /** Scope this scan to a single raw GitHub search query instead of generated brand/keyword queries */
  @Prop()
  scopeQuery?: string;

  @Prop({ type: String, enum: ['repositories', 'code'] })
  scopeSearchKind?: 'repositories' | 'code';

  /** Resolved repo discovery cap for this scan (user-requested, clamped to the admin ceiling). */
  @Prop()
  maxRepos?: number;

  /** Only consider repos created on/after this date (GitHub `created:` qualifier). */
  @Prop({ type: Date })
  createdFrom?: Date;

  /** Only consider repos created on/before this date (GitHub `created:` qualifier). */
  @Prop({ type: Date })
  createdTo?: Date;

  /** Detection ruleset version pinned for this scan */
  @Prop({ default: '' })
  rulesetVersion!: string;

  @Prop({
    type: String,
    required: true,
    enum: ScanJobStatus,
    default: ScanJobStatus.QUEUED,
    index: true,
  })
  status!: ScanJobStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  triggeredBy?: Types.ObjectId;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  finishedAt?: Date;

  /** Hash of scan configuration (brands + limits) for duplicate detection */
  @Prop({ index: true, default: '' })
  configHash!: string;

  /** Stable idempotency key used as BullMQ job id for the orchestrator */
  @Prop({ unique: true, sparse: true, index: true })
  idempotencyKey?: string;

  @Prop({ default: false })
  cancelRequested!: boolean;

  @Prop({ default: 5, min: 1, max: 10 })
  priority!: number;

  @Prop({ default: 0 })
  reposDiscovered!: number;

  @Prop({ default: 0 })
  reposProcessed!: number;

  @Prop({ default: 0 })
  reposFailed!: number;

  @Prop({ default: 0 })
  reposTotal!: number;

  /** @deprecated prefer reposDiscovered */
  @Prop({ default: 0 })
  reposFound!: number;

  /** @deprecated prefer reposProcessed */
  @Prop({ default: 0 })
  reposAnalyzed!: number;

  @Prop({ default: 0 })
  findingsCreated!: number;

  @Prop({ default: 0 })
  findingsUpdated!: number;

  @Prop({ default: 0 })
  reposSkipped!: number;

  @Prop({ default: 0 })
  reposRescanned!: number;

  @Prop({ default: 0 })
  reposResumed!: number;

  @Prop({ default: 0 })
  findingsNew!: number;

  @Prop({ default: 0 })
  findingsUnchanged!: number;

  @Prop({ default: 0 })
  findingsReopened!: number;

  @Prop({ default: 0 })
  findingsResolved!: number;

  @Prop({ default: '' })
  message!: string;

  /** Safe, redacted error message — never store secrets */
  @Prop({ default: '' })
  error!: string;

  @Prop({ type: [String], default: [] })
  queriesUsed!: string[];

  @Prop({ type: [String], default: [] })
  failedRepoKeys!: string[];

  /** Search child jobs still outstanding */
  @Prop({ default: 0 })
  awaitingSearch!: number;

  /** Analysis/detection child jobs still outstanding */
  @Prop({ default: 0 })
  awaitingAnalysis!: number;

  /**
   * Resumable checkpoint — pagination cursors + completed GitHub IDs.
   * Identity is always by githubId (names can change).
   */
  @Prop({
    type: Object,
    default: () => ({
      stage: ScanCheckpointStage.QUEUED,
      updatedAt: null,
      searchCursors: {},
      completedGithubIds: [],
      skippedGithubIds: [],
      failedGithubIds: [],
      pendingGithubIds: [],
      expandedOwners: [],
      expandedForkSources: [],
    }),
  })
  checkpoint!: {
    stage: ScanCheckpointStage | string;
    updatedAt?: Date | string | null;
    /** queryIndex -> last completed page */
    searchCursors: Record<string, number>;
    completedGithubIds: number[];
    skippedGithubIds: number[];
    failedGithubIds: number[];
    pendingGithubIds: number[];
    /** Owners already fan-out expanded in this scan */
    expandedOwners?: string[];
    /** Source githubIds whose forks were already walked */
    expandedForkSources?: number[];
  };

  /** Monotonic progress sequence for SSE reconnect / ordering */
  @Prop({ default: 0 })
  progressSeq!: number;

  @Prop({ default: '' })
  progressPhase!: string;

  @Prop({ default: 0, min: 0, max: 100 })
  progressPercent!: number;

  @Prop({ default: '' })
  progressEventType!: string;

  @Prop({ default: '' })
  progressMessage!: string;

  @Prop({ type: Date })
  progressUpdatedAt?: Date;

  @Prop({ default: false })
  progressTerminal!: boolean;

  @Prop({
    type: Object,
    default: () => ({
      reposDiscovered: 0,
      reposProcessed: 0,
      reposFailed: 0,
      reposTotal: 0,
      findingsCreated: 0,
      findingsUpdated: 0,
      queriesTotal: 0,
      queriesCompleted: 0,
      reposSkipped: 0,
      reposRescanned: 0,
      reposResumed: 0,
      findingsNew: 0,
      findingsUnchanged: 0,
      findingsReopened: 0,
      findingsResolved: 0,
    }),
  })
  progressCounts!: {
    reposDiscovered: number;
    reposProcessed: number;
    reposFailed: number;
    reposTotal: number;
    findingsCreated: number;
    findingsUpdated: number;
    queriesTotal: number;
    queriesCompleted: number;
    reposSkipped: number;
    reposRescanned: number;
    reposResumed: number;
    findingsNew: number;
    findingsUnchanged: number;
    findingsReopened: number;
    findingsResolved: number;
  };
}

export const ScanJobSchema = SchemaFactory.createForClass(ScanJob);
ScanJobSchema.index({ workspaceId: 1, createdAt: -1 });
ScanJobSchema.index({ workspaceId: 1, status: 1 });
ScanJobSchema.index({ workspaceId: 1, configHash: 1, status: 1 });
