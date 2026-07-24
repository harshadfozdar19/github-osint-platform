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

  /** Stable hash to prevent duplicate findings for the same repo+signals */
  @Prop({ required: true, index: true })
  fingerprint!: string;

  @Prop({ type: String, required: true, enum: Severity, index: true })
  severity!: Severity;

  @Prop({ required: true, min: 0, max: 100, index: true })
  riskScore!: number;

  @Prop({ type: [String], enum: ThreatCategory, default: [], index: true })
  categories!: ThreatCategory[];

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
