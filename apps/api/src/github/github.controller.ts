import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
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

  @Get('rate-limit')
  @ApiOperation({
    summary:
      'Shared GitHub rate-limit status, workspace budget, and pause warnings',
  })
  getRateLimit(@CurrentTenant() tenant: TenantContext) {
    return this.github.getStatus(tenant.workspaceId);
  }
}
