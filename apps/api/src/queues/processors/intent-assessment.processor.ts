import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  QUEUE_INTENT_ASSESSMENT,
  IntentAssessmentJobData,
} from '../queue.constants';
import { IntelligenceService } from '../../intelligence/intelligence.service';
import { safeJobError, sharedWorkerTuning } from '../queue.utils';

/**
 * Deliberately low concurrency and no aggressive retry - free-tier LLM APIs
 * (Gemini's free quota especially) have tight per-minute rate limits, and a
 * failed assessment already fails closed inside IntelligenceService.assess
 * (persisted as status: 'failed', not thrown) - retrying the whole job would
 * just burn more of the same limited quota for no benefit.
 */
@Processor(QUEUE_INTENT_ASSESSMENT, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_INTENT || 2),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
  ...sharedWorkerTuning(),
})
export class IntentAssessmentProcessor extends WorkerHost {
  private readonly logger = new Logger(IntentAssessmentProcessor.name);

  constructor(private readonly intelligence: IntelligenceService) {
    super();
  }

  async process(job: Job<IntentAssessmentJobData>): Promise<void> {
    const data = job.data;
    try {
      await this.intelligence.assess(
        data.workspaceId,
        data.repositoryId,
        data.findingId,
      );
    } catch (error) {
      // IntelligenceService.assess already fails closed internally: this
      // catch is only for something outside that (e.g. a Mongo error while
      // persisting the failure record itself) - log and swallow rather than
      // let a bad assessment retry-storm the queue.
      this.logger.warn(
        `Intent assessment job failed for repository ${data.repositoryId}: ${safeJobError(error)}`,
      );
    }
  }
}
