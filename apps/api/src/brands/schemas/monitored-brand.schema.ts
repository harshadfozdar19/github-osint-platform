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

  /**
   * This brand's own real GitHub org/user accounts (if known) - lets
   * discovery search `org:<owner>`/`user:<owner>` unconditionally instead of
   * relying on the brand name happening to co-occur with a keyword or
   * secret pattern. Also used to attribute a match to this brand even when
   * the repo's own name/description never mentions the brand at all (an
   * internal tool repo, say) - see matchBrand().
   */
  @Prop({ type: [String], default: [] })
  trustedGithubOwners!: string[];

  @Prop({ default: true, index: true })
  enabled!: boolean;
}

export const MonitoredBrandSchema =
  SchemaFactory.createForClass(MonitoredBrand);
MonitoredBrandSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
MonitoredBrandSchema.index({ workspaceId: 1, enabled: 1 });
