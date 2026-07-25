import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import { QUEUE_ALERT_DISPATCH, AlertDispatchJobData } from '../queue.constants';
import { ScanStateService } from '../../scans/scan-state.service';
import { AlertsService } from '../../alerts/alerts.service';
import {
  Finding,
  FindingDocument,
} from '../../findings/schemas/finding.schema';
import { safeJobError, sharedWorkerTuning } from '../queue.utils';

@Processor(QUEUE_ALERT_DISPATCH, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_ALERT || 5),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 60_000),
  ...sharedWorkerTuning(),
})
export class AlertDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(AlertDispatchProcessor.name);

  constructor(
    private readonly scanState: ScanStateService,
    private readonly alertsService: AlertsService,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
  ) {
    super();
  }

  async process(job: Job<AlertDispatchJobData>): Promise<void> {
    const { workspaceId, scanJobId, findingId } = job.data;
    try {
      await this.scanState.assertOwned(workspaceId, scanJobId);
      const finding = await this.findingModel
        .findOne({
          _id: findingId,
          workspaceId: new Types.ObjectId(workspaceId),
        })
        .exec();
      if (!finding) {
        this.logger.warn(`Finding ${findingId} not found for alert dispatch`);
        return;
      }
      await this.alertsService.createForFinding(finding);
    } catch (error) {
      this.logger.warn(`Alert dispatch failed: ${safeJobError(error)}`);
      throw error;
    }
  }
}
