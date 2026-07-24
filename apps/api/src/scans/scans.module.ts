import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScanJob, ScanJobSchema } from './schemas/scan-job.schema';
import { ScansService } from './scans.service';
import { ScansController } from './scans.controller';
import { QueuesModule } from '../queues/queues.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GitHubModule } from '../github/github.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ScanJob.name, schema: ScanJobSchema }]),
    QueuesModule.forRoot(),
    // TenantGuard (used on ScansController) depends on WorkspacesService.
    forwardRef(() => WorkspacesModule),
    GitHubModule,
  ],
  providers: [ScansService],
  controllers: [ScansController],
  exports: [ScansService],
})
export class ScansModule {}
