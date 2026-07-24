import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SeedService } from './seed.service';
import { BrandsModule } from '../brands/brands.module';
import { DetectionModule } from '../detection/detection.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Repository,
  RepositorySchema,
} from '../repositories/schemas/repository.schema';
import { Finding, FindingSchema } from '../findings/schemas/finding.schema';
import {
  Detection,
  DetectionSchema,
} from '../detections/schemas/detection.schema';
import { Alert, AlertSchema } from '../alerts/schemas/alert.schema';

@Module({
  imports: [
    BrandsModule,
    DetectionModule,
    forwardRef(() => WorkspacesModule),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Repository.name, schema: RepositorySchema },
      { name: Finding.name, schema: FindingSchema },
      { name: Detection.name, schema: DetectionSchema },
      { name: Alert.name, schema: AlertSchema },
    ]),
  ],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
