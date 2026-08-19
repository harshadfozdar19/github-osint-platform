import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KnownClientSecretDocument = HydratedDocument<KnownClientSecret>;

/**
 * A hash of a real credential value found in a brand's own reference repos -
 * never the value itself. Exists so a secret found later in a THIRD PARTY's
 * repo can be checked for an exact-value match against this set: "this repo
 * is using our actual key" is unambiguous proof, unlike "this repo also has
 * an AWS-key-shaped string". Deliberately never pruned on re-ingestion, even
 * if the source file/credential is later rotated - a match against a
 * historical hash is still valid evidence that the value was copied at some
 * point, and losing that detection capability on rotation would be worse
 * than the minor staleness of keeping it.
 */
@Schema({ timestamps: true, collection: 'known_client_secrets' })
export class KnownClientSecret {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'MonitoredBrand',
    required: true,
    index: true,
  })
  brandId!: Types.ObjectId;

  @Prop({ required: true })
  sourceOwner!: string;

  @Prop({ required: true })
  sourceRepo!: string;

  @Prop({ required: true })
  filePath!: string;

  @Prop({ required: true })
  patternId!: string;

  @Prop({ required: true })
  patternName!: string;

  @Prop({ required: true })
  valueHash!: string;

  @Prop({ type: Date, default: Date.now })
  lastSeenAt!: Date;
}

export const KnownClientSecretSchema =
  SchemaFactory.createForClass(KnownClientSecret);
/** One row per distinct secret value; re-ingestion refreshes location/lastSeenAt rather than duplicating. */
KnownClientSecretSchema.index(
  { workspaceId: 1, brandId: 1, valueHash: 1 },
  { unique: true },
);
/** The reuse-check lookup this collection exists for: does a candidate repo's secret hash match any known client secret in this workspace. */
KnownClientSecretSchema.index({ workspaceId: 1, valueHash: 1 });
