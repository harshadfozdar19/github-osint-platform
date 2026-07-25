import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Workspace, WorkspaceSchema } from './schemas/workspace.schema';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from './schemas/workspace-member.schema';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { UsersModule } from '../users/users.module';
import { BrandsModule } from '../brands/brands.module';
import { TenantGuard } from '../tenancy/tenant.guard';
import { GitHubModule } from '../github/github.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
    ]),
    UsersModule,
    forwardRef(() => BrandsModule),
    forwardRef(() => GitHubModule),
  ],
  providers: [WorkspacesService, TenantGuard],
  controllers: [WorkspacesController],
  exports: [WorkspacesService, TenantGuard, MongooseModule],
})
export class WorkspacesModule {}
