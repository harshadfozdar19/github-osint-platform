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
import {
  OperatorFingerprint,
  OperatorFingerprintSchema,
} from '../detection/schemas/operator-fingerprint.schema';
import {
  RepositoryContributor,
  RepositoryContributorSchema,
} from '../repositories/schemas/repository-contributor.schema';
import { FindingsService } from './findings.service';
import { FindingsController } from './findings.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GitHubModule } from '../github/github.module';
import { CredentialVerificationService } from '../detection/credential-verification.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Finding.name, schema: FindingSchema },
      { name: Detection.name, schema: DetectionSchema },
      { name: Repository.name, schema: RepositorySchema },
      { name: OperatorFingerprint.name, schema: OperatorFingerprintSchema },
      {
        name: RepositoryContributor.name,
        schema: RepositoryContributorSchema,
      },
    ]),
    forwardRef(() => WorkspacesModule),
    forwardRef(() => GitHubModule),
  ],
  providers: [FindingsService, CredentialVerificationService],
  controllers: [FindingsController],
  exports: [FindingsService, MongooseModule],
})
export class FindingsModule {}
