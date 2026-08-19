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

  /** mode=branch_analysis only: the one already-known repository this scan clones and scans. Required alongside scopeBranch. */
  @Prop({ type: Types.ObjectId, ref: 'Repository' })
  scopeRepositoryId?: Types.ObjectId;

  /** mode=branch_analysis only: the one specific branch (not necessarily the default branch) to clone and scan. Required alongside scopeRepositoryId - see ScanMode.BRANCH_ANALYSIS. */
  @Prop()
  scopeBranch?: string;

  /**
   * Internal audit mode: instead of searching GitHub for repos that MENTION
   * the brand (external impersonation/scam discovery), exhaustively
   * enumerate every repo under the scoped brand's own `trustedGithubOwners`
   * accounts and scan those for exposed secrets. Requires scopeBrandId.
   */
  @Prop({ default: false })
  internalAudit!: boolean;

  /**
   * When true, this scan only discovers and records candidate repos
   * (repository metadata already in the search response gets saved with
   * Repository.pendingAnalysis=true) - it never enqueues content analysis
   * (no clone, no file fetch, no detection rules, no findings). Lets
   * discovery be maximized broadly and cheaply now, with the actual
   * analysis run later via ScanMode.ANALYZE_PENDING once you decide what's
   * worth analyzing. Ignored for failed_only/analyze_pending, which are
   * inherently analysis-only modes.
   */
  @Prop({ default: false })
  discoveryOnly!: boolean;

  /** Scope this scan to a single raw GitHub search query instead of generated brand/keyword queries */
  @Prop()
  scopeQuery?: string;

  @Prop({ type: String, enum: ['repositories', 'code'] })
  scopeSearchKind?: 'repositories' | 'code';

  /**
   * Scope this scan to exactly ONE of the brand's own custom keywords
   * instead of the brand's full family sweep (phishing/apk/impersonation/
   * typo-squat/trusted-account/every-keyword) - just that keyword's
   * repo-search + code-search query pair. Requires scopeBrandId. Powers
   * the per-keyword start/stop toggle on the Brands page, where multiple
   * keywords for the same brand can each run as their own independent,
   * concurrently-active scan.
   */
  @Prop()
  scopeKeyword?: string;

  /**
   * True for a scan enqueued by KeywordRotationService rather than the
   * per-keyword watch toggle - suppresses ScanStateService's
   * maybeRestartKeywordWatch cooldown-restart on completion, since the
   * rotation's own advance() already owns "what runs next" for this brand
   * (the next keyword in its order, not this same keyword again).
   */
  @Prop({ default: false })
  rotationManaged!: boolean;

  /**
   * User-edited override for scopeKeyword's normally auto-generated
   * repo-search query string (see buildQueryFamilies' brand-keyword-custom
   * family) - used verbatim, including any date qualifier, instead of
   * calling buildQueryFamilies at all. Only meaningful alongside
   * scopeKeyword; ignored otherwise.
   */
  @Prop()
  customRepoQuery?: string;

  /** Same as customRepoQuery, for the code-search half of the pair (brand-keyword-custom-code). */
  @Prop()
  customCodeQuery?: string;

  /**
   * Restricts scopeKeyword's normally-generated repo-search + code-search
   * pair to just one kind - 'repositories' or 'code' alone, or 'both'
   * (default, unset behaves the same). Lets a user deliberately choose
   * which GitHub search index a keyword's scan spends its time on instead
   * of always running both - e.g. code search's much tighter 10/min
   * ceiling can leave a keyword stuck waiting on it even while repo
   * search (30/min) still has headroom. Only meaningful alongside
   * scopeKeyword; ignored otherwise.
   */
  @Prop({ type: String, enum: ['both', 'repositories', 'code'] })
  searchScope?: 'both' | 'repositories' | 'code';

  /**
   * When this QUEUED scan is actually scheduled to start - set only for a
   * delayed enqueue (see ManualScanOptions.delayMs), used by
   * ScanStateService's keyword-watch auto-restart cooldown so the UI can
   * show "resumes at HH:MM" instead of a bare, unexplained QUEUED that
   * looks identical to "stuck behind a worker backlog."
   */
  @Prop({ type: Date })
  scheduledFor?: Date;

  /** Resolved repo discovery cap for this scan (user-requested, clamped to the admin ceiling). */
  @Prop()
  maxRepos?: number;

  /** Only consider repos created on/after this date (GitHub `created:` qualifier). */
  @Prop({ type: Date })
  createdFrom?: Date;

  /** Only consider repos created on/before this date (GitHub `created:` qualifier). */
  @Prop({ type: Date })
  createdTo?: Date;

  /** Only consider repos last pushed to on/after this date (GitHub `pushed:` qualifier) - independent of createdFrom/createdTo, filters by activity rather than repo age. */
  @Prop({ type: Date })
  pushedFrom?: Date;

  /** Only consider repos last pushed to on/before this date (GitHub `pushed:` qualifier). */
  @Prop({ type: Date })
  pushedTo?: Date;

  /** 'or' = match repos satisfying EITHER the created OR the pushed date range, instead of requiring both ('and', default) - only meaningful when both ranges are set. */
  @Prop({ type: String, enum: ['and', 'or'], default: 'and' })
  dateFilterMode!: 'and' | 'or';

  /**
   * Only meaningful for mode=analyze_pending - narrows which pending-
   * analysis backlog repos this run actually analyzes, by when THIS
   * WORKSPACE discovered them (Repository.createdAt), not any GitHub
   * timestamp. Deliberately separate from createdFrom/createdTo above,
   * which mean "GitHub's own created_at" for a search-time scan - the two
   * concepts would otherwise collide under the same field name across
   * different modes. Matches the Repositories page's own "Discovered"
   * filter naming.
   */
  @Prop({ type: Date })
  discoveredFrom?: Date;

  /** See discoveredFrom. */
  @Prop({ type: Date })
  discoveredTo?: Date;

  /**
   * When true, each search query in this scan resumes from where this
   * workspace's discovery of that exact query text last left off (see
   * DiscoveryCursorService), instead of every scan re-fetching the same
   * most-recently-updated top slice. Default false: unchanged behavior
   * unless explicitly requested.
   */
  @Prop({ default: false })
  continueDiscovery!: boolean;

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

  /** Repos this scan discovered and saved but deliberately did NOT analyze (discoveryOnly mode) - see Repository.pendingAnalysis. */
  @Prop({ default: 0 })
  reposPendingAnalysis!: number;

  @Prop({ default: 0 })
  findingsNew!: number;

  @Prop({ default: 0 })
  findingsUnchanged!: number;

  @Prop({ default: 0 })
  findingsReopened!: number;

  @Prop({ default: 0 })
  findingsResolved!: number;

  /** Repos processed in this scan whose finding came out HIGH or CRITICAL severity - the "how many are actually a real threat" count. */
  @Prop({ default: 0 })
  findingsHighRisk!: number;

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
    /**
     * queryIndex -> the page this scan actually started that query on, set
     * once at orchestration time before any search job runs. Page 1 means it
     * started fresh; anything higher is visible proof it picked up a prior
     * scan's durable DiscoveryCursor instead of re-fetching the same top
     * results - see ScanOrchestratorProcessor's resumePage logic, and the
     * "Search continuation" list rendered from this on the scan detail page.
     */
    searchStartPages?: Record<string, number>;
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
      reposPendingAnalysis: 0,
      findingsNew: 0,
      findingsUnchanged: 0,
      findingsReopened: 0,
      findingsResolved: 0,
      findingsHighRisk: 0,
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
    reposPendingAnalysis: number;
    findingsNew: number;
    findingsUnchanged: number;
    findingsReopened: number;
    findingsResolved: number;
    findingsHighRisk: number;
  };
}

export const ScanJobSchema = SchemaFactory.createForClass(ScanJob);
ScanJobSchema.index({ workspaceId: 1, createdAt: -1 });
ScanJobSchema.index({ workspaceId: 1, status: 1 });
ScanJobSchema.index({ workspaceId: 1, configHash: 1, status: 1 });
