import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScanJob, ScanJobSchema } from './schemas/scan-job.schema';
import {
  Repository,
  RepositorySchema,
} from '../repositories/schemas/repository.schema';
import { ScansService } from './scans.service';
import { ScansController } from './scans.controller';
import { SeenRepositoriesService } from './seen-repositories.service';
import { QueuesModule } from '../queues/queues.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GitHubModule } from '../github/github.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ScanJob.name, schema: ScanJobSchema },
      { name: Repository.name, schema: RepositorySchema },
    ]),
    QueuesModule.forRoot(),
    // TenantGuard (used on ScansController) depends on WorkspacesService.
    forwardRef(() => WorkspacesModule),
    GitHubModule,
  ],
  providers: [ScansService, SeenRepositoriesService],
  controllers: [ScansController],
  exports: [ScansService],
})
export class ScansModule {}
