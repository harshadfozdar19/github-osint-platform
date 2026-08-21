import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type IntentAssessmentDocument = HydratedDocument<IntentAssessment>;

export enum RepositoryIntent {
  MALICIOUS_OPERATION = 'malicious_operation',
  IMPERSONATION = 'impersonation',
  CREDENTIAL_HARVESTING = 'credential_harvesting',
  PHISHING_ACTIVE = 'phishing_active',
  BENIGN = 'benign',
  INCONCLUSIVE = 'inconclusive',
}

/**
 * One LLM-generated intent/risk assessment for a repository, kept as its own
 * append-only history (not fields bolted onto Finding/Repository) so a
 * re-run after a prompt or model change never clobbers what an earlier
 * version actually said - `promptVersion` + `model` make every row
 * independently auditable, and the latest one per repository is just
 * `findOne({repositoryId}).sort({createdAt: -1})`.
 */
@Schema({ timestamps: true, collection: 'intent_assessments' })
export class IntentAssessment {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Repository',
    required: true,
    index: true,
  })
  repositoryId!: Types.ObjectId;

  /** The finding whose creation/reopening triggered this assessment, if any. */
  @Prop({ type: Types.ObjectId, ref: 'Finding' })
  findingId?: Types.ObjectId;

  @Prop({ required: true, enum: RepositoryIntent })
  intent!: RepositoryIntent;

  @Prop({ required: true, min: 0, max: 100 })
  riskScore!: number;

  @Prop({ required: true, min: 0, max: 1 })
  confidence!: number;

  @Prop({ required: true })
  reasoning!: string;

  @Prop({ type: [String], default: [] })
  signalsUsed!: string[];

  /** Which backend actually produced this - 'gemini' | 'openrouter'. */
  @Prop({ required: true })
  provider!: string;

  /** The specific model id used (e.g. "gemini-2.5-flash") - providers can be reconfigured to a different model over time. */
  @Prop({ required: true })
  model!: string;

  /** Bumped whenever the system prompt/taxonomy/schema changes - lets old assessments be identified and re-run. */
  @Prop({ required: true })
  promptVersion!: string;

  @Prop({ required: true, enum: ['completed', 'failed'], default: 'completed' })
  status!: 'completed' | 'failed';

  @Prop({ type: String })
  error?: string;

  /**
   * Analyst thumbs-up/down on this specific assessment - the "true or false"
   * feedback loop: accumulates into the few-shot example pool future
   * assessments are prompted with, and into the precision-tracking metric.
   */
  @Prop({ type: String, enum: ['agree', 'disagree'] })
  analystAgreement?: 'agree' | 'disagree';
}

export const IntentAssessmentSchema =
  SchemaFactory.createForClass(IntentAssessment);
IntentAssessmentSchema.index({
  workspaceId: 1,
  repositoryId: 1,
  createdAt: -1,
});
