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
import { IntelligenceService } from './intelligence.service';
import { IntelligenceController } from './intelligence.controller';
import { IntentContextBuilder } from './intent-context.builder';
import { GeminiIntentProvider } from './providers/gemini-intent.provider';
import { OpenRouterIntentProvider } from './providers/openrouter-intent.provider';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IntentAssessment.name, schema: IntentAssessmentSchema },
      { name: Repository.name, schema: RepositorySchema },
      { name: Finding.name, schema: FindingSchema },
      { name: Detection.name, schema: DetectionSchema },
    ]),
    forwardRef(() => WorkspacesModule),
  ],
  controllers: [IntelligenceController],
  providers: [
    IntelligenceService,
    IntentContextBuilder,
    GeminiIntentProvider,
    OpenRouterIntentProvider,
  ],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
