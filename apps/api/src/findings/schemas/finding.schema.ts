import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  FindingStatus,
  Severity,
  ThreatCategory,
  FindingChangeType,
} from '../../common/enums';

export type FindingDocument = HydratedDocument<Finding>;

@Schema({ _id: false })
export class RiskBreakdownEntry {
  @Prop({ required: true })
  factor!: string;

  @Prop({ required: true })
  points!: number;

  @Prop({ required: true })
  detail!: string;
}

/** Why brandName is what it is - a verified account, an exact text match, or a fuzzy one - see common/brand-match.ts. */
@Schema({ _id: false })
export class BrandMatchEvidenceEntry {
  @Prop({ required: true })
  type!: string;

  @Prop({ required: true })
  location!: string;

  @Prop({ required: true })
  matchedAlias!: string;

  @Prop({ required: true })
  matchedText!: string;

  /** Which file the match was found in - set only when location is 'file_content'. */
  @Prop()
  filePath?: string;

  /** 1-indexed line the match was found on - set only when location is 'readme' or 'file_content'. */
  @Prop()
  lineNumber?: number;
}

@Schema({ timestamps: true, collection: 'findings' })
export class Finding {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Repository',
    required: true,
    index: true,
  })
  repositoryId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MonitoredBrand', index: true })
  brandId?: Types.ObjectId;

  @Prop({ index: true })
  brandName?: string;

  @Prop({ type: BrandMatchEvidenceEntry })
  brandMatchEvidence?: BrandMatchEvidenceEntry;

  /**
   * 'internal' = found by exhaustively enumerating the brand's own
   * trustedGithubOwners repos (an exposed-secret audit of OUR OWN code -
   * fix by rotating the credential). 'external' (default) = found by
   * searching GitHub broadly for repos mentioning the brand (someone else's
   * repo impersonating/scamming with our name - fix by reporting/takedown).
   * Same repo could in principle appear both ways over time; this reflects
   * how it was MOST RECENTLY found.
   */
  @Prop({ type: String, enum: ['internal', 'external'], default: 'external' })
  origin!: 'internal' | 'external';

  /** Stable hash to prevent duplicate findings for the same repo+signals */
  @Prop({ required: true, index: true })
  fingerprint!: string;

  @Prop({ type: String, required: true, enum: Severity, index: true })
  severity!: Severity;

  @Prop({ required: true, min: 0, max: 100, index: true })
  riskScore!: number;

  @Prop({ type: [String], enum: ThreatCategory, default: [], index: true })
  categories!: ThreatCategory[];

  /**
   * How many distinct curated keywords matched this repo (count of this
   * finding's own 'custom-keyword-match' detections - see
   * customKeywordMatchRule) - denormalized here, same as `categories`
   * below, purely so the findings list can sort/filter by it directly
   * without a $lookup into the separate detections collection on every
   * page load.
   */
  @Prop({ default: 0, index: true })
  keywordMatchCount!: number;

  @Prop({ type: [RiskBreakdownEntry], default: [] })
  riskBreakdown!: RiskBreakdownEntry[];

  @Prop({ required: true })
  summary!: string;

  @Prop({
    type: String,
    default: FindingStatus.OPEN,
    enum: FindingStatus,
    index: true,
  })
  status!: FindingStatus;

  /** How this finding changed on the most recent scan that touched it */
  @Prop({
    type: String,
    enum: FindingChangeType,
    default: FindingChangeType.NEW,
    index: true,
  })
  lastChangeType!: FindingChangeType;

  @Prop({ type: Types.ObjectId, ref: 'ScanJob', index: true })
  lastScanJobId?: Types.ObjectId;

  @Prop({ type: Date })
  resolvedAt?: Date;

  @Prop({ type: Date })
  reopenedAt?: Date;

  /** Analyst triage note (false-positive rationale, handoff context, etc.) */
  @Prop({ default: '' })
  triageNote!: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  triagedBy?: Types.ObjectId;

  @Prop({ type: Date })
  triagedAt?: Date;

  @Prop({ type: Date, default: Date.now, index: true })
  firstSeenAt!: Date;

  @Prop({ type: Date, default: Date.now, index: true })
  lastSeenAt!: Date;

  @Prop({ default: false })
  isDemo!: boolean;

  /**
   * Which branch this finding was most recently seen on, when known - unset
   * for the overwhelming majority of findings, which come from the normal
   * default-branch pipeline (GitHub's search index only ever covers a repo's
   * default branch, and the regular clone/REST fetch paths don't track a
   * branch at all). Only ever set by ScanMode.BRANCH_ANALYSIS, scanning one
   * specific non-default branch a user asked to check on demand. Not part
   * of the fingerprint or the unique index below: the exact same secret
   * value/pattern at the same repo+path+line is one real finding regardless
   * of which branch(es) happen to contain it, so a repeat fingerprint match
   * on a different branch updates this field (and lastSeenAt) on the
   * existing Finding rather than creating a second one - this field records
   * "where it was last seen," not "every branch it's ever been on."
   */
  @Prop({ type: String })
  branch?: string;
}

export const FindingSchema = SchemaFactory.createForClass(Finding);
FindingSchema.index(
  { workspaceId: 1, repositoryId: 1, fingerprint: 1 },
  { unique: true },
);
FindingSchema.index({ workspaceId: 1, createdAt: -1 });
FindingSchema.index({ workspaceId: 1, severity: 1, riskScore: -1 });
FindingSchema.index({ workspaceId: 1, brandName: 1 });
FindingSchema.index({ workspaceId: 1, status: 1, lastSeenAt: -1 });
