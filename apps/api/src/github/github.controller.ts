import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { WORKSPACE_HEADER } from '../common/enums';
import { GitHubService } from './github.service';

@ApiTags('github')
@ApiBearerAuth()
@ApiSecurity('workspace')
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('github')
export class GitHubController {
  constructor(private readonly github: GitHubService) {}

  @Get('search')
  @ApiOperation({ summary: 'Search GitHub repositories directly' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'type', required: false, enum: ['repositories', 'code'] })
  async search(
    @CurrentTenant() tenant: TenantContext,
    @Query('q') q: string,
    @Query('page') page = '1',
    @Query('type') type: 'repositories' | 'code' = 'repositories',
  ) {
    const p = Math.max(1, Number(page) || 1);
    if (type === 'code') {
      return this.github.searchCode(q, p, 10, {
        workspaceId: tenant.workspaceId,
      });
    }
    return this.github.searchRepositories(q, p, 10, {
      workspaceId: tenant.workspaceId,
    });
  }

  @Get('rate-limit')
  @ApiOperation({
    summary:
      'Shared GitHub rate-limit status, workspace budget, and pause warnings',
  })
  getRateLimit(@CurrentTenant() tenant: TenantContext) {
    return this.github.getStatus(tenant.workspaceId);
  }
}
