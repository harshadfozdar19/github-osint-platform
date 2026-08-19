import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RepositoryDocument = HydratedDocument<Repository>;

/** One OTHER brand (besides discoveryBrandId) whose own keyword search also matched this repo - see Repository.additionalBrandMatches. */
export interface RepositoryBrandMatch {
  brandId: Types.ObjectId;
  keyword?: string;
  matchedField?: string;
  matchedPath?: string;
  matchedText?: string;
  discoveredAt: Date;
}

/** GitHub's own "Deployments" feature - a live environment URL, not GitHub Pages. See GitHubService.getLatestDeployment. */
export interface RepositoryDeployment {
  environment: string;
  url: string;
  state: string;
  updatedAt?: Date;
}

@Schema({ timestamps: true, collection: 'repositories' })
export class Repository {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  /** Stable GitHub identity — never rely on fullName alone (renames). */
  @Prop({ required: true, index: true })
  githubId!: number;

  @Prop({ required: true, index: true })
  fullName!: string;

  @Prop({ required: true })
  url!: string;

  @Prop({ required: true, index: true })
  owner!: string;

  @Prop({ default: '' })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ default: '', index: true })
  language!: string;

  @Prop({ type: [String], default: [] })
  topics!: string[];

  @Prop({ default: 0 })
  stars!: number;

  @Prop({ default: 0 })
  forks!: number;

  @Prop({ default: false })
  isFork!: boolean;

  @Prop({ type: Date })
  githubCreatedAt?: Date;

  /** GitHub `updated_at` */
  @Prop({ type: Date, index: true })
  githubUpdatedAt?: Date;

  /** GitHub `pushed_at` */
  @Prop({ type: Date, index: true })
  githubPushedAt?: Date;

  @Prop({ default: '' })
  defaultBranch!: string;

  /** HEAD commit SHA last successfully analyzed */
  @Prop({ default: '', index: true })
  lastProcessedCommitSha!: string;

  @Prop({ type: Date, index: true })
  lastSuccessfulScanAt?: Date;

  /** Detection ruleset version applied on last successful analysis */
  @Prop({ default: '', index: true })
  lastRulesetVersion!: string;

  /** Content ETag when available (readme/contents) */
  @Prop({ default: '' })
  lastContentEtag!: string;

  @Prop({ default: false, index: true })
  lastProcessingFailed!: boolean;

  @Prop({ type: Types.ObjectId, ref: 'ScanJob' })
  lastScanJobId?: Types.ObjectId;

  @Prop({ type: Date, index: true })
  lastScannedAt?: Date;

  @Prop({ default: false })
  isDemo!: boolean;

  /**
   * True from the moment a discovery-only scan first finds this repo until
   * a real content-analysis pass actually runs on it (see
   * ScanPipelineService.upsertRepository's discoveredOnly option and the
   * ANALYZE_PENDING scan mode that clears it). Lets discovery be run far
   * ahead of - and independently from - the expensive clone/detect step:
   * gather broadly now, decide what's worth analyzing later.
   */
  @Prop({ default: false, index: true })
  pendingAnalysis!: boolean;

  /**
   * Best-effort discovery-time match evidence, captured for free from the
   * search response that found this repo - see
   * GitHubSearchProcessor.resolveDiscoveryMatchEvidence. NOT the same
   * confidence as a real Finding's brandMatchEvidence (a content-analysis
   * pass hasn't actually opened this repo yet), but still real: which field
   * (repo_name/description/topics) or, for a code-search hit, which file
   * literally contains the discovering scan's own keyword. Cleared back to
   * '' once a real analysis pass runs (see ScanPipelineService.
   * upsertRepository) since a Finding's own evidence supersedes it.
   */
  @Prop({ default: '' })
  discoveryMatchedField!: string;

  /** Set only when discoveryMatchedField is 'file_content' - the exact path GitHub's code search reported the hit in. */
  @Prop({ default: '' })
  discoveryMatchedPath!: string;

  /** The literal metadata text (repo name/description/topics) that matched, for a repo_name/description/topics discoveryMatchedField. */
  @Prop({ default: '' })
  discoveryMatchedText!: string;

  /**
   * Which company/keyword's discovery scan first found this repo - unlike
   * discoveryMatchedField/Path/Text (which describe evidence and go stale
   * once real analysis supersedes them), this stays put permanently once
   * set: "which keyword found this" remains a true historical fact even
   * after the repo has since been content-analyzed. Powers the Repositories
   * page's per-keyword filter (see the sequential scheduler's "View" link).
   */
  @Prop({ type: Types.ObjectId, ref: 'MonitoredBrand' })
  discoveryBrandId?: Types.ObjectId;

  @Prop({ type: String })
  discoveryKeyword?: string;

  /**
   * How this repo entered the workspace: 'external' = a keyword/GitHub
   * search found it (the common case - impersonation/leak hunting across
   * all of GitHub); 'internal' = an internal audit enumerated it directly
   * from a monitored brand's own trustedGithubOwners accounts, with no
   * keyword search involved at all. Unlike discoveryKeyword (only ever
   * stamped on a discovery-only pass, so it can be empty for a
   * keyword-found repo that went straight to analysis), this is set on
   * every upsert from every code path - see ScanPipelineService.
   * upsertRepository - so it's reliable for filtering even when
   * discoveryKeyword itself is blank. Powers the Repositories page's
   * "only repos actually found via a keyword search" default.
   */
  @Prop({ type: String, enum: ['internal', 'external'], default: 'external', index: true })
  origin!: 'internal' | 'external';

  /**
   * Every OTHER brand (besides discoveryBrandId, whichever one's scan
   * found this repo FIRST) whose own keyword search also matched this
   * exact repo - see GitHubSearchProcessor's cross-scan dedup and
   * IncrementalScanService.recordAdditionalBrandMatch. Without this, a
   * repo relevant to more than one monitored brand (a broker-comparison
   * app mentioning several brands by name, say) would silently vanish for
   * every brand except whichever one's scan happened to discover it
   * first - the Repositories page's per-brand filter would never show it
   * under any OTHER brand it's just as genuinely relevant to, even though
   * a plain GitHub search for that brand's own name would return it.
   * Deliberately a separate array rather than promoting discoveryBrandId
   * itself to a list - keeps "who found this repo first" unambiguous
   * while still surfacing every other brand it's also relevant to.
   */
  @Prop({
    type: [
      {
        brandId: { type: Types.ObjectId, ref: 'MonitoredBrand' },
        keyword: String,
        matchedField: String,
        matchedPath: String,
        matchedText: String,
        discoveredAt: Date,
      },
    ],
    default: [],
  })
  additionalBrandMatches!: RepositoryBrandMatch[];

  /**
   * Most recent live deployment found on this repo's GitHub Deployments API
   * (a hosted, running environment - e.g. a phishing clone actually served
   * somewhere) - see GitHubService.getLatestDeployment. Populated only on a
   * real content-analysis pass, same as the contributor rows in the sibling
   * `repository_contributors` collection; null/absent means either no
   * deployment exists or the repo hasn't been analyzed yet.
   */
  @Prop({
    type: {
      environment: String,
      url: String,
      state: String,
      updatedAt: Date,
    },
    default: null,
  })
  deployment?: RepositoryDeployment | null;
}

export const RepositorySchema = SchemaFactory.createForClass(Repository);
RepositorySchema.index({ workspaceId: 1, githubId: 1 }, { unique: true });
RepositorySchema.index({ workspaceId: 1, fullName: 1 });
/** Repeat-operator lookup: other repos by the same account in this workspace. */
RepositorySchema.index({ workspaceId: 1, owner: 1 });
RepositorySchema.index({ workspaceId: 1, stars: 1, githubCreatedAt: -1 });
/** Efficient incremental change detection */
RepositorySchema.index({
  workspaceId: 1,
  githubId: 1,
  lastProcessedCommitSha: 1,
  lastRulesetVersion: 1,
});
RepositorySchema.index({
  workspaceId: 1,
  lastProcessingFailed: 1,
  githubPushedAt: -1,
});
RepositorySchema.index({
  workspaceId: 1,
  lastSuccessfulScanAt: 1,
  githubUpdatedAt: -1,
});
/** Backs listPendingAnalysisGithubIds / the "Analyze discovered repositories" count. */
RepositorySchema.index({ workspaceId: 1, pendingAnalysis: 1 });
/** Backs the /repositories page's default "most recently discovered first" listing order. */
RepositorySchema.index({ workspaceId: 1, createdAt: -1 });
/** Backs the per-keyword "View" filter from the sequential scheduler. */
RepositorySchema.index({ workspaceId: 1, discoveryBrandId: 1, discoveryKeyword: 1 });
