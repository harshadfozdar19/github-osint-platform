import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MonitoredBrandDocument = HydratedDocument<MonitoredBrand>;

@Schema({ timestamps: true, collection: 'monitoredbrands' })
export class MonitoredBrand {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: '' })
  description?: string;

  @Prop({ type: [String], default: [] })
  aliases!: string[];

  @Prop({ type: [String], default: [] })
  keywords!: string[];

  @Prop({ default: true, index: true })
  enabled!: boolean;
}

export const MonitoredBrandSchema =
  SchemaFactory.createForClass(MonitoredBrand);
MonitoredBrandSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
MonitoredBrandSchema.index({ workspaceId: 1, enabled: 1 });
