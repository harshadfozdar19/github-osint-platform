import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RepositoryDocument = HydratedDocument<Repository>;

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

  @Prop({ default: '' })
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

  @Prop({ type: Date })
  lastScannedAt?: Date;

  @Prop({ default: false })
  isDemo!: boolean;
}

export const RepositorySchema = SchemaFactory.createForClass(Repository);
RepositorySchema.index({ workspaceId: 1, githubId: 1 }, { unique: true });
RepositorySchema.index({ workspaceId: 1, fullName: 1 });
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
