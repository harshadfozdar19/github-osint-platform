import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  IntentAssessment,
  IntentAssessmentSchema,
} from './schemas/intent-assessment.schema';
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
  MonitoredBrand,
  MonitoredBrandSchema,
} from '../brands/schemas/monitored-brand.schema';
import { IntelligenceService } from './intelligence.service';
import { IntelligenceController } from './intelligence.controller';
import { IntentContextBuilder } from './intent-context.builder';
import { DeepIntentContextBuilder } from './deep-intent-context.builder';
import { GeminiIntentProvider } from './providers/gemini-intent.provider';
import { OpenRouterIntentProvider } from './providers/openrouter-intent.provider';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GitHubModule } from '../github/github.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IntentAssessment.name, schema: IntentAssessmentSchema },
      { name: Repository.name, schema: RepositorySchema },
      { name: Finding.name, schema: FindingSchema },
      { name: Detection.name, schema: DetectionSchema },
      { name: OperatorFingerprint.name, schema: OperatorFingerprintSchema },
      { name: RepositoryContributor.name, schema: RepositoryContributorSchema },
      { name: MonitoredBrand.name, schema: MonitoredBrandSchema },
    ]),
    forwardRef(() => WorkspacesModule),
    GitHubModule,
  ],
  controllers: [IntelligenceController],
  providers: [
    IntelligenceService,
    IntentContextBuilder,
    DeepIntentContextBuilder,
    GeminiIntentProvider,
    OpenRouterIntentProvider,
  ],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
