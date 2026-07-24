import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Alert, AlertDocument } from './schemas/alert.schema';
import { FindingDocument } from '../findings/schemas/finding.schema';

@Injectable()
export class AlertsService {
  constructor(
    @InjectModel(Alert.name) private readonly alertModel: Model<AlertDocument>,
  ) {}

  async createForFinding(finding: FindingDocument) {
    const existing = await this.alertModel
      .findOne({
        findingId: finding._id,
        workspaceId: finding.workspaceId,
      })
      .exec();
    if (existing) return existing;

    return this.alertModel.create({
      workspaceId: finding.workspaceId,
      findingId: finding._id,
      severity: finding.severity,
      title: `${finding.severity.toUpperCase()} risk detected`,
      message: finding.summary,
      read: false,
      channel: 'in_app',
    });
  }

  async list(workspaceId: string, page = 1, limit = 20, unreadOnly = false) {
    const filter: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
    };
    if (unreadOnly) filter.read = false;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.alertModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('findingId')
        .lean()
        .exec(),
      this.alertModel.countDocuments(filter).exec(),
    ]);
    return { data, total, page, limit };
  }

  async markRead(workspaceId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Alert not found');
    }
    const alert = await this.alertModel
      .findOneAndUpdate(
        { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
        { read: true },
        { new: true },
      )
      .lean()
      .exec();
    if (!alert) throw new NotFoundException('Alert not found');
    return alert;
  }

  async unreadCount(workspaceId: string) {
    return this.alertModel
      .countDocuments({
        workspaceId: new Types.ObjectId(workspaceId),
        read: false,
      })
      .exec();
  }
}
