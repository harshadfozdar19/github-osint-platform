import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';

import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Observable, map } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/current-user.decorator';
import { ScansService } from './scans.service';
import { paginate } from '../common/dto/pagination.dto';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { WORKSPACE_HEADER } from '../common/enums';
import { ScanProgressService } from './progress/scan-progress.service';
import { ManualScanDto } from './dto/manual-scan.dto';
import { GitHubService } from '../github/github.service';

@ApiTags('scans')
@ApiBearerAuth()
@ApiSecurity('workspace')
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('scans')
export class ScansController {
  constructor(
    private readonly scansService: ScansService,
    private readonly progressService: ScanProgressService,
    private readonly github: GitHubService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List scan job history for the workspace' })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 20));
    const result = await this.scansService.list(tenant.workspaceId, p, l);
    return paginate(result.data, result.total, p, l);
  }

  @Post('manual')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Enqueue a manual GitHub OSINT scan. Returns 202 with persisted scan ID. Modes: incremental | full | failed_only.',
  })
  startManual(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: AuthUser,
    @Body() body: ManualScanDto = {},
  ) {
    return this.scansService.startManualScan(tenant.workspaceId, user.id, {
      mode: body.mode,
      forceFullScan: body.forceFullScan,
      force: body.force,
      brandId: body.brandId,
      customQuery: body.customQuery,
      searchKind: body.searchKind,
      maxRepos: body.maxRepos,
    });
  }

  @Get('search')
  @ApiOperation({
    summary:
      'Run a custom GitHub search query (forwards through managed GitHub client with rate-limit awareness)',
  })
  @ApiQuery({ name: 'q', required: true, description: 'GitHub search query' })
  @ApiQuery({ name: 'page', required: false, example: '1' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['repositories', 'code'],
    description: 'Search type (default: repositories)',
  })
  async customSearch(
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

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a queued or running scan' })
  cancel(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.scansService.cancelScan(tenant.workspaceId, id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Retry a failed/partial/cancelled scan by enqueueing a new job',
  })
  retry(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.scansService.retryScan(tenant.workspaceId, id, user.id);
  }

  @Get(':id/progress')
  @ApiOperation({
    summary:
      'Polling fallback for latest scan progress (afterSeq skips unchanged)',
  })
  async getProgress(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Query('afterSeq') afterSeq = '0',
  ) {
    const seq = Math.max(0, Number(afterSeq) || 0);
    const event = await this.progressService.getLatest(
      tenant.workspaceId,
      id,
      seq,
    );
    return { event };
  }

  @Sse(':id/events')
  @ApiOperation({
    summary:
      'Server-Sent Events stream for scan progress (auth + workspace required)',
  })
  events(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Query('afterSeq') afterSeq = '0',
  ): Observable<MessageEvent> {
    const seq = Math.max(0, Number(afterSeq) || 0);
    return this.progressService.stream(tenant.workspaceId, id, seq).pipe(
      map((chunk) => ({
        data: chunk.data,
        id: chunk.id,
        type: chunk.type,
      })),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a scan job by id within the workspace' })
  async getById(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
  ) {
    const job = await this.scansService.findById(tenant.workspaceId, id);
    if (!job) throw new NotFoundException('Scan job not found');
    return job;
  }
}
