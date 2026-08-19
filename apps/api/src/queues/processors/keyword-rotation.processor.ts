import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_KEYWORD_ROTATION, KeywordRotationJobData } from '../queue.constants';
import { KeywordRotationService } from '../../scans/keyword-rotation.service';
import { safeJobError } from '../queue.utils';
import { sharedWorkerTuning } from '../queue.utils';

/**
 * Fires once per keyword-rotation slot, delayed by that slot's own duration
 * - see KeywordRotationService.startSlot. Low concurrency is fine (and
 * deliberate): this only ever hands off between keywords, it never does the
 * actual GitHub work itself.
 */
@Processor(QUEUE_KEYWORD_ROTATION, {
  concurrency: 4,
  ...sharedWorkerTuning(),
})
export class KeywordRotationProcessor extends WorkerHost {
  private readonly logger = new Logger(KeywordRotationProcessor.name);

  constructor(private readonly rotation: KeywordRotationService) {
    super();
  }

  async process(job: Job<KeywordRotationJobData>): Promise<void> {
    const { workspaceId, token } = job.data;
    try {
      await this.rotation.advance(workspaceId, { token });
    } catch (err) {
      this.logger.warn(
        `Keyword rotation advance failed for workspace ${workspaceId}: ${safeJobError(err)}`,
      );
    }
  }
}
