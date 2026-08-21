import { DynamicModule, Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ALL_SCAN_QUEUES,
  QUEUE_ALERT_DISPATCH,
  QUEUE_DETECTION_PROCESSING,
  QUEUE_GITHUB_SEARCH,
  QUEUE_KEYWORD_ROTATION,
  QUEUE_REPOSITORY_ANALYSIS,
  QUEUE_SCAN_ORCHESTRATOR,
} from './queue.constants';
import { ScanQueueService } from './scan-queue.service';
import { ScanPipelineService } from '../scans/scan-pipeline.service';
import { CloneScanService } from '../scans/clone-scan.service';
import { ScanStateService } from '../scans/scan-state.service';
import { ScanJob, ScanJobSchema } from '../scans/schemas/scan-job.schema';
import {
  DiscoveryCursor,
  DiscoveryCursorSchema,
} from '../scans/schemas/discovery-cursor.schema';
import {
  KeywordRotation,
  KeywordRotationSchema,
} from '../scans/schemas/keyword-rotation.schema';
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
import {
  OperatorFingerprint,
  OperatorFingerprintSchema,
} from '../detection/schemas/operator-fingerprint.schema';
import {
  RepositoryContributor,
  RepositoryContributorSchema,
} from '../repositories/schemas/repository-contributor.schema';
import {
  KnownClientSecret,
  KnownClientSecretSchema,
} from '../fingerprints/schemas/known-client-secret.schema';
import {
  DistinctiveContentString,
  DistinctiveContentStringSchema,
} from '../fingerprints/schemas/distinctive-content-string.schema';
import {
  CodeFingerprint,
  CodeFingerprintSchema,
} from '../fingerprints/schemas/code-fingerprint.schema';
import { GitHubModule } from '../github/github.module';
import { DetectionModule } from '../detection/detection.module';
import { AlertsModule } from '../alerts/alerts.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ScanProgressService } from '../scans/progress/scan-progress.service';
import { IncrementalScanService } from '../scans/incremental-scan.service';
import { DiscoveryExpansionService } from '../scans/discovery-expansion.service';
import { DiscoveryCursorService } from '../scans/discovery-cursor.service';
import { KeywordRotationService } from '../scans/keyword-rotation.service';
import { ScanOrchestratorProcessor } from './processors/scan-orchestrator.processor';

import { GitHubSearchProcessor } from './processors/github-search.processor';
import { RepositoryAnalysisProcessor } from './processors/repository-analysis.processor';
import { DetectionProcessingProcessor } from './processors/detection-processing.processor';
import { AlertDispatchProcessor } from './processors/alert-dispatch.processor';
import { KeywordRotationProcessor } from './processors/keyword-rotation.processor';
import { BranchAnalysisProcessor } from './processors/branch-analysis.processor';
import { IntentAssessmentProcessor } from './processors/intent-assessment.processor';

const queueRegistrations = [
  ...ALL_SCAN_QUEUES.map((name) => ({ name })),
  { name: QUEUE_KEYWORD_ROTATION },
];

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
    { name: DiscoveryCursor.name, schema: DiscoveryCursorSchema },
    { name: KeywordRotation.name, schema: KeywordRotationSchema },
    { name: MonitoredBrand.name, schema: MonitoredBrandSchema },
    { name: Keyword.name, schema: KeywordSchema },
    { name: Repository.name, schema: RepositorySchema },
    { name: Finding.name, schema: FindingSchema },
    { name: Detection.name, schema: DetectionSchema },
    { name: OperatorFingerprint.name, schema: OperatorFingerprintSchema },
    {
      name: RepositoryContributor.name,
      schema: RepositoryContributorSchema,
    },
    { name: KnownClientSecret.name, schema: KnownClientSecretSchema },
    {
      name: DistinctiveContentString.name,
      schema: DistinctiveContentStringSchema,
    },
    { name: CodeFingerprint.name, schema: CodeFingerprintSchema },
  ]),
  GitHubModule,
  DetectionModule,
  AlertsModule,
  IntelligenceModule,
  forwardRef(() => WorkspacesModule),
];

const sharedProviders = [
  ScanQueueService,
  ScanPipelineService,
  CloneScanService,
  ScanStateService,
  ScanProgressService,
  IncrementalScanService,
  DiscoveryExpansionService,
  DiscoveryCursorService,
  KeywordRotationService,
];

const workerProviders = [
  ScanOrchestratorProcessor,
  GitHubSearchProcessor,
  RepositoryAnalysisProcessor,
  DetectionProcessingProcessor,
  AlertDispatchProcessor,
  KeywordRotationProcessor,
  BranchAnalysisProcessor,
  IntentAssessmentProcessor,
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
        KeywordRotationService,
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
