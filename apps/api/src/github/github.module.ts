import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GitHubService } from './github.service';
import { GitHubHttpClient } from './github-http.client';
import { GitHubRateLimitStore } from './github-rate-limit.store';
import { GitHubController } from './github.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [ConfigModule, WorkspacesModule],
  providers: [GitHubRateLimitStore, GitHubHttpClient, GitHubService],
  controllers: [GitHubController],
  exports: [GitHubService, GitHubHttpClient, GitHubRateLimitStore],
})
export class GitHubModule {}
