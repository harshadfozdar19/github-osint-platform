import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { WorkspaceMemberStatus, WorkspaceRole } from '../../common/enums';

export type WorkspaceMemberDocument = HydratedDocument<WorkspaceMember>;

@Schema({ timestamps: true, collection: 'workspacemembers' })
export class WorkspaceMember {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  userId?: Types.ObjectId;

  @Prop({ required: true, lowercase: true, trim: true, index: true })
  email!: string;

  @Prop({ required: true, type: String, enum: WorkspaceRole, index: true })
  role!: WorkspaceRole;

  @Prop({
    required: true,
    type: String,
    enum: WorkspaceMemberStatus,
    default: WorkspaceMemberStatus.ACTIVE,
    index: true,
  })
  status!: WorkspaceMemberStatus;
}

export const WorkspaceMemberSchema =
  SchemaFactory.createForClass(WorkspaceMember);
WorkspaceMemberSchema.index(
  { workspaceId: 1, userId: 1 },
  { unique: true, sparse: true },
);
WorkspaceMemberSchema.index({ workspaceId: 1, email: 1 }, { unique: true });
WorkspaceMemberSchema.index({ userId: 1, status: 1 });
