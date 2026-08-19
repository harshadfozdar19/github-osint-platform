import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Severity, ThreatCategory } from '../../common/enums';

export type DetectionDocument = HydratedDocument<Detection>;

/**
 * Outcome of an analyst-triggered live check against the credential's own
 * provider (see CredentialVerificationService) - never stores the raw
 * secret value itself, only the verdict.
 */
@Schema({ _id: false })
export class DetectionVerification {
  @Prop({ required: true })
  status!: string;

  @Prop({ required: true })
  detail!: string;

  @Prop({ required: true })
  checkedAt!: Date;
}

@Schema({ timestamps: true, collection: 'detections' })
export class Detection {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Finding', required: true, index: true })
  findingId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  ruleId!: string;

  @Prop({ required: true })
  ruleName!: string;

  @Prop({ type: String, required: true, enum: ThreatCategory, index: true })
  category!: ThreatCategory;

  @Prop({ type: String, required: true, enum: Severity })
  severity!: Severity;

  @Prop({ required: true, min: 0, max: 1 })
  confidence!: number;

  /** Always redacted before persistence */
  @Prop({ required: true })
  evidence!: string;

  @Prop({ required: true })
  explanation!: string;

  @Prop({ required: true, min: 0 })
  riskContribution!: number;

  @Prop({ type: String, default: '' })
  file?: string;

  @Prop({ type: Number, default: 0 })
  lineNumber?: number;

  @Prop({ type: String, default: '' })
  matchedText?: string;

  @Prop({ type: DetectionVerification })
  verification?: DetectionVerification;
}

export const DetectionSchema = SchemaFactory.createForClass(Detection);
DetectionSchema.index({ workspaceId: 1, findingId: 1, ruleId: 1 });
