import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DistinctiveContentStringDocument =
  HydratedDocument<DistinctiveContentString>;

/**
 * A distinctive brand-content phrase (UI copy, locale string, legal text)
 * pulled from a brand's own reference repos - stored as plaintext
 * (deliberately, unlike CodeFingerprint) because it exists to be used
 * verbatim as GitHub search bait and as human-readable evidence, not as a
 * privacy-preserving fingerprint.
 */
@Schema({ timestamps: true, collection: 'distinctive_content_strings' })
export class DistinctiveContentString {
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

  @Prop({
    type: String,
    required: true,
    enum: ['locale', 'template', 'legal', 'docs'],
  })
  category!: string;

  @Prop({ required: true })
  text!: string;

  @Prop({ required: true })
  significantWordCount!: number;

  @Prop({ type: Date, default: Date.now })
  ingestedAt!: Date;
}

export const DistinctiveContentStringSchema = SchemaFactory.createForClass(
  DistinctiveContentString,
);
DistinctiveContentStringSchema.index(
  {
    workspaceId: 1,
    brandId: 1,
    sourceOwner: 1,
    sourceRepo: 1,
    filePath: 1,
    text: 1,
  },
  { unique: true },
);
/** Lookup used by discovery when picking bait strings for a brand. */
DistinctiveContentStringSchema.index({
  workspaceId: 1,
  brandId: 1,
  significantWordCount: -1,
});
