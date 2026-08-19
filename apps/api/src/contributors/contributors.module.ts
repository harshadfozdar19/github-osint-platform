import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RepositoryContributor,
  RepositoryContributorSchema,
} from '../repositories/schemas/repository-contributor.schema';
import {
  Repository,
  RepositorySchema,
} from '../repositories/schemas/repository.schema';
import {
  MonitoredBrand,
  MonitoredBrandSchema,
} from '../brands/schemas/monitored-brand.schema';
import { ContributorsService } from './contributors.service';
import { ContributorsController } from './contributors.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: RepositoryContributor.name,
        schema: RepositoryContributorSchema,
      },
      { name: Repository.name, schema: RepositorySchema },
      { name: MonitoredBrand.name, schema: MonitoredBrandSchema },
    ]),
    forwardRef(() => WorkspacesModule),
  ],
  providers: [ContributorsService],
  controllers: [ContributorsController],
  exports: [ContributorsService],
})
export class ContributorsModule {}
