import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RepositoryContributorDocument = HydratedDocument<RepositoryContributor>;

/**
 * One row per (repo, GitHub contributor) found during a real content-analysis
 * pass. Modeled after OperatorFingerprint: kept separate from Repository
 * itself so the same {workspaceId, login} lookup that finds a shared
 * email/wallet across owners can also find the same GitHub account showing
 * up as a contributor on several different repos in this workspace.
 */
@Schema({ timestamps: true, collection: 'repository_contributors' })
export class RepositoryContributor {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Repository',
    required: true,
    index: true,
  })
  repositoryId!: Types.ObjectId;

  /** Denormalized so a cross-repo match is displayable with no extra join. */
  @Prop({ required: true })
  owner!: string;

  @Prop({ required: true })
  fullName!: string;

  @Prop({ required: true, index: true })
  login!: string;

  @Prop({ type: String })
  avatarUrl?: string;

  /** Commit count on THIS repo, as reported by GitHub's contributors API. */
  @Prop({ default: 0 })
  contributions!: number;

  @Prop({ type: Date, default: Date.now })
  lastSeenAt!: Date;
}

export const RepositoryContributorSchema = SchemaFactory.createForClass(
  RepositoryContributor,
);
RepositoryContributorSchema.index(
  { workspaceId: 1, repositoryId: 1, login: 1 },
  { unique: true },
);
/** The cross-repo lookup this collection exists for: same login, other repos. */
RepositoryContributorSchema.index({ workspaceId: 1, login: 1 });
