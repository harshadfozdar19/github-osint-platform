import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WorkspaceDocument = HydratedDocument<Workspace>;

@Schema({ timestamps: true, collection: 'workspaces' })
export class Workspace {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  })
  slug!: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  ownerId!: Types.ObjectId;

  @Prop({ default: false })
  isDefault!: boolean;

  // AES-256-GCM encrypted GitHub token, optional per-workspace override of
  // the shared GITHUB_TOKEN env var. The master key lives only in server env
  // (TOKEN_ENCRYPTION_KEY) — never in this document — so DB access alone
  // (a backup, a dump, a read-only compromise) never yields the plaintext
  // token. Plaintext is never returned by any API response; only the last 4
  // characters (githubTokenLast4) are ever shown, for user recognition only.
  @Prop()
  githubTokenCiphertext?: string;

  @Prop()
  githubTokenIv?: string;

  @Prop()
  githubTokenAuthTag?: string;

  @Prop()
  githubTokenLast4?: string;

  @Prop()
  githubTokenUpdatedAt?: Date;
}

export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);
WorkspaceSchema.index({ ownerId: 1, createdAt: -1 });
