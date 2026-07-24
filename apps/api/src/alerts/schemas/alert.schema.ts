import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Severity } from '../../common/enums';

export type AlertDocument = HydratedDocument<Alert>;

@Schema({ timestamps: true, collection: 'alerts' })
export class Alert {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Finding', required: true, index: true })
  findingId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: Severity, index: true })
  severity!: Severity;

  @Prop({ required: true })
  title!: string;

  @Prop({ required: true })
  message!: string;

  @Prop({ default: false, index: true })
  read!: boolean;

  /** Future channels: email | slack | in_app */
  @Prop({ default: 'in_app' })
  channel!: string;
}

export const AlertSchema = SchemaFactory.createForClass(Alert);
AlertSchema.index({ workspaceId: 1, createdAt: -1 });
AlertSchema.index({ workspaceId: 1, read: 1, createdAt: -1 });
AlertSchema.index({ workspaceId: 1, findingId: 1 });
