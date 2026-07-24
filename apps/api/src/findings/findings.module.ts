import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Finding, FindingSchema } from './schemas/finding.schema';
import {
  Detection,
  DetectionSchema,
} from '../detections/schemas/detection.schema';
import {
  Repository,
  RepositorySchema,
} from '../repositories/schemas/repository.schema';
import { FindingsService } from './findings.service';
import { FindingsController } from './findings.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Finding.name, schema: FindingSchema },
      { name: Detection.name, schema: DetectionSchema },
      { name: Repository.name, schema: RepositorySchema },
    ]),
    forwardRef(() => WorkspacesModule),
  ],
  providers: [FindingsService],
  controllers: [FindingsController],
  exports: [FindingsService, MongooseModule],
})
export class FindingsModule {}
