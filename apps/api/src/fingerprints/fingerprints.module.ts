import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CodeFingerprint,
  CodeFingerprintSchema,
} from './schemas/code-fingerprint.schema';
import {
  DistinctiveContentString,
  DistinctiveContentStringSchema,
} from './schemas/distinctive-content-string.schema';
import {
  KnownClientSecret,
  KnownClientSecretSchema,
} from './schemas/known-client-secret.schema';
import {
  MonitoredBrand,
  MonitoredBrandSchema,
} from '../brands/schemas/monitored-brand.schema';
import { ReferenceFingerprintService } from './reference-fingerprint.service';
import { FingerprintsController } from './fingerprints.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CodeFingerprint.name, schema: CodeFingerprintSchema },
      {
        name: DistinctiveContentString.name,
        schema: DistinctiveContentStringSchema,
      },
      { name: KnownClientSecret.name, schema: KnownClientSecretSchema },
      { name: MonitoredBrand.name, schema: MonitoredBrandSchema },
    ]),
    forwardRef(() => WorkspacesModule),
  ],
  providers: [ReferenceFingerprintService],
  controllers: [FingerprintsController],
  exports: [ReferenceFingerprintService, MongooseModule],
})
export class FingerprintsModule {}
