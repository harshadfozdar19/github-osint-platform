import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TrackedGithubUserDocument = HydratedDocument<TrackedGithubUser>;

/**
 * A GitHub username a workspace wants to keep an eye on - not tied to any
 * one repo/company, just a manually curated watchlist of operators. Doesn't
 * store any commit data itself (no GitHub API call ever made for this) -
 * the whole point is a one-click link out to GitHub's own commit search
 * (author:<username>, newest first), which already shows everything public
 * that person has committed across every repo GitHub can see. See
 * TrackedUsersService.commitSearchUrl.
 */
@Schema({ timestamps: true, collection: 'tracked_github_users' })
export class TrackedGithubUser {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  /** GitHub login, exactly as entered (case-preserved for display). */
  @Prop({ required: true, trim: true, maxlength: 100 })
  username!: string;

  /** Lowercased copy of `username` - backs the case-insensitive uniqueness check and lookups, since Mongo has no case-insensitive unique index without a collation. */
  @Prop({ required: true, index: true })
  usernameLower!: string;

  /** Optional analyst note - e.g. which repo/finding first surfaced this person. */
  @Prop({ default: '' })
  note!: string;
}

export const TrackedGithubUserSchema =
  SchemaFactory.createForClass(TrackedGithubUser);
TrackedGithubUserSchema.index(
  { workspaceId: 1, usernameLower: 1 },
  { unique: true },
);
