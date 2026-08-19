import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FINGERPRINT_KINDS } from '../../common/operator-fingerprint';
import type { FingerprintKind } from '../../common/operator-fingerprint';

export type OperatorFingerprintDocument = HydratedDocument<OperatorFingerprint>;

/**
 * One row per (repo, contact/wallet fingerprint) found during a scan. Kept
 * separate from Finding/Repository since it's cross-owner by design - the
 * whole point is looking this up by {workspaceId, kind, value} regardless of
 * which repository or owner wrote it, to find every *other* identity that
 * shares it.
 */
@Schema({ timestamps: true, collection: 'operator_fingerprints' })
export class OperatorFingerprint {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Repository',
    required: true,
    index: true,
  })
  repositoryId!: Types.ObjectId;

  /** Denormalized so a cross-owner match is displayable with no extra join. */
  @Prop({ required: true, index: true })
  owner!: string;

  @Prop({ required: true })
  fullName!: string;

  @Prop({ type: String, required: true, enum: FINGERPRINT_KINDS, index: true })
  kind!: FingerprintKind;

  @Prop({ required: true })
  value!: string;

  @Prop({ type: Date, default: Date.now })
  lastSeenAt!: Date;
}

export const OperatorFingerprintSchema =
  SchemaFactory.createForClass(OperatorFingerprint);
OperatorFingerprintSchema.index(
  { workspaceId: 1, repositoryId: 1, kind: 1, value: 1 },
  { unique: true },
);
/** The cross-owner lookup this entire collection exists for. */
OperatorFingerprintSchema.index({ workspaceId: 1, kind: 1, value: 1 });
