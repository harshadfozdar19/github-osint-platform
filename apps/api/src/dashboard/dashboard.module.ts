import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Finding, FindingSchema } from '../findings/schemas/finding.schema';
import {
  Repository,
  RepositorySchema,
} from '../repositories/schemas/repository.schema';
import { Alert, AlertSchema } from '../alerts/schemas/alert.schema';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GitHubModule } from '../github/github.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Finding.name, schema: FindingSchema },
      { name: Repository.name, schema: RepositorySchema },
      { name: Alert.name, schema: AlertSchema },
    ]),
    forwardRef(() => WorkspacesModule),
    GitHubModule,
  ],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
