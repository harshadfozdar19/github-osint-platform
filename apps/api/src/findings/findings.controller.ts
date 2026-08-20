import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
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
  FindingListStatus,
  Severity,
  ThreatCategory,
  WORKSPACE_HEADER,
} from '../common/enums';
import type { ThreatClass } from '../common/threat-classification';
import { paginate } from '../common/dto/pagination.dto';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/current-user.decorator';
import { UpdateFindingStatusDto } from './dto/update-finding-status.dto';
import { UpdateFindingListStatusDto } from './dto/update-finding-list-status.dto';

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
  @ApiQuery({
    name: 'threatClass',
    required: false,
    enum: ['credential_exposure', 'malicious_intent', 'other'],
    description:
      'credential_exposure = accidental leak (fix: rotate); malicious_intent = deliberate attack (fix: report/takedown)',
  })
  @ApiQuery({ name: 'status', required: false, enum: FindingStatus })
  @ApiQuery({
    name: 'listStatus',
    required: false,
    enum: FindingListStatus,
    description:
      'Analyst classification tag (watchlist/ignorelist/allowlist/blocklist) - independent of status',
  })
  @ApiQuery({
    name: 'origin',
    required: false,
    enum: ['internal', 'external'],
    description:
      "internal = found in the brand's own repo (fix: rotate the credential); external = found in someone else's repo (fix: report/takedown)",
  })
  @ApiQuery({ name: 'brand', required: false })
  @ApiQuery({
    name: 'from',
    required: false,
    description:
      'Findings first recorded on/after this date (our own discovery time, not GitHub activity)',
  })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({
    name: 'repoActiveFrom',
    required: false,
    description:
      "Only findings whose repository was created OR pushed to (commits/branch updates) on/after this date, per GitHub - independent of 'from'/'to' above, which filter by when WE recorded the finding.",
  })
  @ApiQuery({ name: 'repoActiveTo', required: false })
  @ApiQuery({
    name: 'hasDeployment',
    required: false,
    description:
      "'true' = only repos with a live deployment URL found; 'false' = only repos with none (\"not defined\")",
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sortBy', required: false })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('search') search?: string,
    @Query('severity') severity?: Severity,
    @Query('category') category?: ThreatCategory,
    @Query('threatClass') threatClass?: ThreatClass,
    @Query('status') status?: FindingStatus,
    @Query('listStatus') listStatus?: FindingListStatus,
    @Query('origin') origin?: 'internal' | 'external',
    @Query('brand') brand?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('repoActiveFrom') repoActiveFrom?: string,
    @Query('repoActiveTo') repoActiveTo?: string,
    @Query('hasDeployment') hasDeployment?: string,
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
      threatClass,
      status,
      listStatus,
      origin,
      brand,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      repoActiveFrom: repoActiveFrom ? new Date(repoActiveFrom) : undefined,
      repoActiveTo: repoActiveTo ? new Date(repoActiveTo) : undefined,
      hasDeployment:
        hasDeployment === undefined ? undefined : hasDeployment === 'true',
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 20)),
      sortBy: sortBy || 'createdAt',
      sortOrder: sortOrder || 'desc',
    });
    return paginate(result.data, result.total, result.page, result.limit);
  }

  @Get('rule-precision')
  @ApiOperation({
    summary:
      "Per-rule false-positive rate for this workspace's own triage history — which rules are actually reliable here",
  })
  getRulePrecision(@CurrentTenant() tenant: TenantContext) {
    return this.findingsService.getRulePrecisionStats(tenant.workspaceId);
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

  @Post(':id/detections/:detectionId/verify')
  @ApiOperation({
    summary:
      "Manually verify whether an exposed-secret detection is still a live, working credential (makes a live, read-only check against the credential's own provider - e.g. GitHub /user, Stripe /v1/balance). Never run automatically; analyst-triggered only.",
  })
  verifyDetectionCredential(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Param('detectionId') detectionId: string,
  ) {
    return this.findingsService.verifyDetectionCredential(
      tenant.workspaceId,
      id,
      detectionId,
    );
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

  @Patch(':id/list-status')
  @ApiOperation({
    summary:
      'Classify a finding into a watch/ignore/allow/block list - independent of the triage status above',
  })
  updateListStatus(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateFindingListStatusDto,
  ) {
    return this.findingsService.updateListStatus(tenant.workspaceId, id, dto);
  }
}
