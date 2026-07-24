import { DynamicModule, Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ALL_SCAN_QUEUES,
  QUEUE_ALERT_DISPATCH,
  QUEUE_DETECTION_PROCESSING,
  QUEUE_GITHUB_SEARCH,
  QUEUE_REPOSITORY_ANALYSIS,
  QUEUE_SCAN_ORCHESTRATOR,
} from './queue.constants';
import { ScanQueueService } from './scan-queue.service';
import { ScanPipelineService } from '../scans/scan-pipeline.service';
import { ScanStateService } from '../scans/scan-state.service';
import { ScanJob, ScanJobSchema } from '../scans/schemas/scan-job.schema';
import {
  MonitoredBrand,
  MonitoredBrandSchema,
} from '../brands/schemas/monitored-brand.schema';
import { Keyword, KeywordSchema } from '../keywords/schemas/keyword.schema';
import {
  Repository,
  RepositorySchema,
} from '../repositories/schemas/repository.schema';
import { Finding, FindingSchema } from '../findings/schemas/finding.schema';
import {
  Detection,
  DetectionSchema,
} from '../detections/schemas/detection.schema';
import { GitHubModule } from '../github/github.module';
import { DetectionModule } from '../detection/detection.module';
import { AlertsModule } from '../alerts/alerts.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ScanProgressService } from '../scans/progress/scan-progress.service';
import { IncrementalScanService } from '../scans/incremental-scan.service';
import { DiscoveryExpansionService } from '../scans/discovery-expansion.service';
import { ScanOrchestratorProcessor } from './processors/scan-orchestrator.processor';

import { GitHubSearchProcessor } from './processors/github-search.processor';
import { RepositoryAnalysisProcessor } from './processors/repository-analysis.processor';
import { DetectionProcessingProcessor } from './processors/detection-processing.processor';
import { AlertDispatchProcessor } from './processors/alert-dispatch.processor';

const queueRegistrations = ALL_SCAN_QUEUES.map((name) => ({ name }));

const sharedImports = [
  ConfigModule,
  BullModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (config: ConfigService) => {
      const url = config.get<string>('REDIS_URL')?.trim();
      if (url) {
        return { connection: { url } };
      }
      return {
        connection: {
          host: config.get<string>('REDIS_HOST') || 'localhost',
          port: Number(config.get<string>('REDIS_PORT') || 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          maxRetriesPerRequest: null,
        },
      };
    },
  }),
  BullModule.registerQueue(...queueRegistrations),
  MongooseModule.forFeature([
    { name: ScanJob.name, schema: ScanJobSchema },
    { name: MonitoredBrand.name, schema: MonitoredBrandSchema },
    { name: Keyword.name, schema: KeywordSchema },
    { name: Repository.name, schema: RepositorySchema },
    { name: Finding.name, schema: FindingSchema },
    { name: Detection.name, schema: DetectionSchema },
  ]),
  GitHubModule,
  DetectionModule,
  AlertsModule,
  forwardRef(() => WorkspacesModule),
];

const sharedProviders = [
  ScanQueueService,
  ScanPipelineService,
  ScanStateService,
  ScanProgressService,
  IncrementalScanService,
  DiscoveryExpansionService,
];

const workerProviders = [
  ScanOrchestratorProcessor,
  GitHubSearchProcessor,
  RepositoryAnalysisProcessor,
  DetectionProcessingProcessor,
  AlertDispatchProcessor,
];

@Module({})
export class QueuesModule {
  /** API process: producers only (no workers unless ENABLE_QUEUE_WORKERS=true). */
  static forRoot(): DynamicModule {
    const enableWorkers =
      (process.env.ENABLE_QUEUE_WORKERS || 'true').toLowerCase() === 'true';
    return {
      module: QueuesModule,
      imports: sharedImports,
      providers: [
        ...sharedProviders,
        ...(enableWorkers ? workerProviders : []),
      ],
      exports: [
        ScanQueueService,
        ScanPipelineService,
        ScanStateService,
        ScanProgressService,
        IncrementalScanService,
        BullModule,
        MongooseModule,
      ],
    };
  }

  /** Dedicated worker process: always registers processors. */
  static forWorker(): DynamicModule {
    return {
      module: QueuesModule,
      imports: sharedImports,
      providers: [...sharedProviders, ...workerProviders],
      exports: [
        ScanQueueService,
        ScanPipelineService,
        ScanStateService,
        ScanProgressService,
        IncrementalScanService,
        BullModule,
      ],
    };
  }
}

export {
  QUEUE_SCAN_ORCHESTRATOR,
  QUEUE_GITHUB_SEARCH,
  QUEUE_REPOSITORY_ANALYSIS,
  QUEUE_DETECTION_PROCESSING,
  QUEUE_ALERT_DISPATCH,
};
