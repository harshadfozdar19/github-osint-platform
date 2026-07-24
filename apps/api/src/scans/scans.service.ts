import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ScanJob, ScanJobDocument } from './schemas/scan-job.schema';
import { ScanQueueService } from '../queues/scan-queue.service';
import type { ManualScanOptions } from '../queues/scan-queue.service';

@Injectable()
export class ScansService {
  constructor(
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    private readonly scanQueue: ScanQueueService,
  ) {}

  list(workspaceId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const filter = { workspaceId: new Types.ObjectId(workspaceId) };
    return Promise.all([
      this.scanModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.scanModel.countDocuments(filter).exec(),
    ]).then(([data, total]) => ({ data, total, page, limit }));
  }

  async findById(workspaceId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.scanModel
      .findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) })
      .lean()
      .exec();
  }

  /** Enqueue async scan — returns persisted job immediately (HTTP 202). */
  async startManualScan(
    workspaceId: string,
    userId: string,
    options: ManualScanOptions = {},
  ) {
    return this.scanQueue.enqueueManualScan(workspaceId, userId, options);
  }

  async cancelScan(workspaceId: string, scanJobId: string) {
    return this.scanQueue.cancelScan(workspaceId, scanJobId);
  }

  async retryScan(workspaceId: string, scanJobId: string, userId: string) {
    return this.scanQueue.retryFailedScan(workspaceId, scanJobId, userId);
  }
}
