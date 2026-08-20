import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ContributorsService } from './contributors.service';
import { WORKSPACE_HEADER } from '../common/enums';
import { paginate } from '../common/dto/pagination.dto';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';

@ApiTags('contributors')
@ApiBearerAuth()
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('contributors')
export class ContributorsController {
  constructor(private readonly contributorsService: ContributorsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List GitHub contributors seen across this workspace during deep analysis, each with total repo count and company breakdown',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'GitHub login substring',
  })
  @ApiQuery({
    name: 'companyId',
    required: false,
    description:
      'Only contributors with at least one repo discovered for this MonitoredBrand',
  })
  @ApiQuery({
    name: 'minRepositories',
    required: false,
    description:
      'Only contributors active on at least this many distinct repos in the workspace',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['totalRepositories', 'login'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('search') search?: string,
    @Query('companyId') companyId?: string,
    @Query('minRepositories') minRepositories?: string,
    @Query('sortBy') sortBy?: 'totalRepositories' | 'login',
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const result = await this.contributorsService.list({
      workspaceId: tenant.workspaceId,
      search,
      companyId,
      minRepositories: minRepositories ? Number(minRepositories) : undefined,
      sortBy,
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 20)),
    });
    return paginate(result.data, result.total, result.page, result.limit);
  }
}
