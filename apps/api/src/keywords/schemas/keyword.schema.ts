import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KeywordDocument = HydratedDocument<Keyword>;

@Schema({ timestamps: true, collection: 'keywords' })
export class Keyword {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  keyword!: string;

  @Prop({ required: true, trim: true, default: 'general' })
  category!: string;

  @Prop({ type: Number, default: 5, min: 1, max: 10 })
  priority!: number;

  @Prop({ default: true, index: true })
  enabled!: boolean;

  /** 'auto' when promoted from a confirmed Critical/High finding, not user-entered. */
  @Prop({ type: String, enum: ['manual', 'auto'], default: 'manual' })
  source!: 'manual' | 'auto';
}

export const KeywordSchema = SchemaFactory.createForClass(Keyword);
KeywordSchema.index({ workspaceId: 1, keyword: 1 }, { unique: true });
KeywordSchema.index({ workspaceId: 1, enabled: 1 });
