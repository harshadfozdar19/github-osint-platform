import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FindingsService } from './findings.service';
import {
  FindingStatus,
  Severity,
  ThreatCategory,
  WORKSPACE_HEADER,
} from '../common/enums';
import { paginate } from '../common/dto/pagination.dto';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/current-user.decorator';
import { UpdateFindingStatusDto } from './dto/update-finding-status.dto';

@ApiTags('findings')
@ApiBearerAuth()
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('findings')
export class FindingsController {
  constructor(private readonly findingsService: FindingsService) {}

  @Get()
  @ApiOperation({ summary: 'List findings with filters and pagination' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'severity', required: false, enum: Severity })
  @ApiQuery({ name: 'category', required: false, enum: ThreatCategory })
  @ApiQuery({ name: 'status', required: false, enum: FindingStatus })
  @ApiQuery({ name: 'brand', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sortBy', required: false })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('search') search?: string,
    @Query('severity') severity?: Severity,
    @Query('category') category?: ThreatCategory,
    @Query('status') status?: FindingStatus,
    @Query('brand') brand?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ) {
    const result = await this.findingsService.list({
      workspaceId: tenant.workspaceId,
      search,
      severity,
      category,
      status,
      brand,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 20)),
      sortBy: sortBy || 'createdAt',
      sortOrder: sortOrder || 'desc',
    });
    return paginate(result.data, result.total, result.page, result.limit);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get finding detail with detections and repository info',
  })
  getById(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    return this.findingsService.getById(tenant.workspaceId, id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary:
      'Triage a finding (acknowledge / false positive / resolved / reopen)',
  })
  updateStatus(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateFindingStatusDto,
  ): Promise<Record<string, unknown>> {
    return this.findingsService.updateStatus(
      tenant.workspaceId,
      id,
      user.id,
      dto,
    );
  }
}
