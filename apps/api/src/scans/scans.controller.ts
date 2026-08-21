import {
  BadRequestException,
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
import { ScanJobStatus, WORKSPACE_HEADER } from '../common/enums';
import { ScanProgressService } from './progress/scan-progress.service';
import { ManualScanDto } from './dto/manual-scan.dto';
import { AnalyzeBranchDto } from './dto/analyze-branch.dto';
import {
  AddKeywordRotationSlotsDto,
  KeywordRotationSlotRefDto,
  SetKeywordRotationSlotContinueDiscoveryDto,
  SetKeywordRotationSlotSearchScopeDto,
  StartKeywordRotationDto,
} from './dto/keyword-rotation.dto';
import { GitHubService } from '../github/github.service';
import {
  buildCreatedQualifier,
  buildPushedQualifier,
} from './discovery/query-families';
import { SeenRepositoriesService } from './seen-repositories.service';

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
    private readonly seenRepos: SeenRepositoriesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List scan job history for the workspace' })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'Comma-separated ScanJobStatus values to restrict to (e.g. "queued,running" for only active scans) - omit for full history',
  })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 20));
    const statusFilter = status
      ?.split(',')
      .map((s) => s.trim())
      .filter((s): s is ScanJobStatus =>
        Object.values(ScanJobStatus).includes(s as ScanJobStatus),
      );
    const result = await this.scansService.list(tenant.workspaceId, p, l, {
      status: statusFilter,
    });
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
      internalAudit: body.internalAudit,
      keyword: body.keyword,
      customRepoQuery: body.customRepoQuery,
      customCodeQuery: body.customCodeQuery,
      maxRepos: body.maxRepos,
      createdFrom: body.createdFrom,
      createdTo: body.createdTo,
      pushedFrom: body.pushedFrom,
      pushedTo: body.pushedTo,
      dateFilterMode: body.dateFilterMode,
      continueDiscovery: body.continueDiscovery,
      discoveryOnly: body.discoveryOnly,
    });
  }

  @Get('repositories')
  @ApiOperation({
    summary:
      'List discovered repositories for the workspace (found by any scan, analyzed or still pending) - the browsable counterpart to pending-analysis-count',
  })
  @ApiQuery({ name: 'page', required: false, example: '1' })
  @ApiQuery({ name: 'limit', required: false, example: '20' })
  @ApiQuery({
    name: 'pendingAnalysis',
    required: false,
    description:
      'true = only repos not yet content-analyzed, false = only analyzed ones',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Case-insensitive substring match on owner/repo full name',
  })
  @ApiQuery({
    name: 'brandId',
    required: false,
    description:
      'Only repos whose discovering scan was scoped to this exact company',
  })
  @ApiQuery({
    name: 'keyword',
    required: false,
    description:
      "Only repos whose discovering scan was scoped to this exact keyword - requires brandId alongside it (a keyword alone isn't unique across companies)",
  })
  @ApiQuery({
    name: 'language',
    required: false,
    description:
      "Exact (case-insensitive) match on GitHub's reported primary language",
  })
  @ApiQuery({
    name: 'matchLocation',
    required: false,
    description:
      'Where the brand match was found (repo_name, description, topics, file_content, readme, ...)',
  })
  @ApiQuery({
    name: 'discoveredFrom',
    required: false,
    description:
      'Repository.createdAt (when WE first recorded it) on/after this date',
  })
  @ApiQuery({ name: 'discoveredTo', required: false })
  @ApiQuery({
    name: 'githubCreatedFrom',
    required: false,
    description: 'GitHub-reported repo creation date on/after this date',
  })
  @ApiQuery({ name: 'githubCreatedTo', required: false })
  @ApiQuery({
    name: 'pushedFrom',
    required: false,
    description: 'Last GitHub push on/after this date',
  })
  @ApiQuery({ name: 'pushedTo', required: false })
  @ApiQuery({
    name: 'lastScannedFrom',
    required: false,
    description: 'Our own last analysis pass on/after this date',
  })
  @ApiQuery({ name: 'lastScannedTo', required: false })
  async listRepositories(
    @CurrentTenant() tenant: TenantContext,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('pendingAnalysis') pendingAnalysis?: string,
    @Query('search') search?: string,
    @Query('brandId') brandId?: string,
    @Query('keyword') keyword?: string,
    @Query('language') language?: string,
    @Query('matchLocation') matchLocation?: string,
    @Query('discoveredFrom') discoveredFrom?: string,
    @Query('discoveredTo') discoveredTo?: string,
    @Query('githubCreatedFrom') githubCreatedFrom?: string,
    @Query('githubCreatedTo') githubCreatedTo?: string,
    @Query('pushedFrom') pushedFrom?: string,
    @Query('pushedTo') pushedTo?: string,
    @Query('lastScannedFrom') lastScannedFrom?: string,
    @Query('lastScannedTo') lastScannedTo?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 20));
    const result = await this.scansService.listRepositories(
      tenant.workspaceId,
      p,
      l,
      {
        pendingAnalysis:
          pendingAnalysis === 'true'
            ? true
            : pendingAnalysis === 'false'
              ? false
              : undefined,
        search,
        brandId,
        keyword,
        language,
        matchLocation,
        discoveredFrom: discoveredFrom ? new Date(discoveredFrom) : undefined,
        discoveredTo: discoveredTo ? new Date(discoveredTo) : undefined,
        githubCreatedFrom: githubCreatedFrom
          ? new Date(githubCreatedFrom)
          : undefined,
        githubCreatedTo: githubCreatedTo
          ? new Date(githubCreatedTo)
          : undefined,
        pushedFrom: pushedFrom ? new Date(pushedFrom) : undefined,
        pushedTo: pushedTo ? new Date(pushedTo) : undefined,
        lastScannedFrom: lastScannedFrom
          ? new Date(lastScannedFrom)
          : undefined,
        lastScannedTo: lastScannedTo ? new Date(lastScannedTo) : undefined,
      },
    );
    return paginate(result.data, result.total, p, l);
  }

  @Get('repositories/languages')
  @ApiOperation({
    summary:
      "Distinct GitHub languages seen among this workspace's discovered repos - powers the Repositories page's Language filter dropdown",
  })
  async listRepositoryLanguages(@CurrentTenant() tenant: TenantContext) {
    return this.scansService.listDistinctRepositoryLanguages(
      tenant.workspaceId,
    );
  }

  @Get('repositories/recent-changes')
  @ApiOperation({
    summary:
      'Two views of "this repo recently changed": repos pushed to on GitHub recently, and repos where a rescan just turned up a new or reopened finding - powers the Repositories page\'s Recent changes section',
  })
  @ApiQuery({ name: 'days', required: false, example: '7' })
  @ApiQuery({ name: 'limit', required: false, example: '8' })
  @ApiQuery({ name: 'brandId', required: false })
  async getRecentChanges(
    @CurrentTenant() tenant: TenantContext,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('brandId') brandId?: string,
  ) {
    return this.scansService.getRecentChanges(tenant.workspaceId, {
      days: days ? Number(days) : undefined,
      limit: limit ? Number(limit) : undefined,
      brandId: brandId || undefined,
    });
  }

  @Get('repositories/:id/branches')
  @ApiOperation({
    summary:
      "Every branch this repository actually has on GitHub, not just its default one - GitHub's search index only ever covers the default branch, so this is the only way to even discover a side branch exists. Flags which one is the default.",
  })
  async listRepositoryBranches(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
  ) {
    return this.scansService.listRepositoryBranches(tenant.workspaceId, id);
  }

  @Post('repositories/:id/branches/analyze')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Starts an on-demand clone+scan of one specific branch of one already-known repository (ScanMode.BRANCH_ANALYSIS) - for checking a side branch a search hit never surfaced. Returns the created scan job immediately; poll it the same way as any other scan.',
  })
  async analyzeRepositoryBranch(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AnalyzeBranchDto,
  ) {
    return this.scansService.startBranchAnalysis(
      tenant.workspaceId,
      user.id,
      id,
      dto.branch,
    );
  }

  @Get('pending-analysis-count')
  @ApiOperation({
    summary:
      'Count of repos discovered (by a discoveryOnly scan) but not yet analyzed - for the "Analyze discovered repositories" action. Optionally narrowed to one brand and/or a discovered-date window, matching whatever scope the actual analyze_pending run would use, so the button always shows an accurate count for what it\'s about to do.',
  })
  @ApiQuery({ name: 'brandId', required: false })
  @ApiQuery({ name: 'discoveredFrom', required: false })
  @ApiQuery({ name: 'discoveredTo', required: false })
  async pendingAnalysisCount(
    @CurrentTenant() tenant: TenantContext,
    @Query('brandId') brandId?: string,
    @Query('discoveredFrom') discoveredFrom?: string,
    @Query('discoveredTo') discoveredTo?: string,
  ) {
    const count = await this.scansService.countPendingAnalysis(
      tenant.workspaceId,
      {
        brandId,
        discoveredFrom: discoveredFrom ? new Date(discoveredFrom) : undefined,
        discoveredTo: discoveredTo ? new Date(discoveredTo) : undefined,
      },
    );
    return { count };
  }

  @Get('analyzed-count')
  @ApiOperation({
    summary:
      'Count of already-analyzed repos eligible for a keyword-driven re-analysis - for the "Re-analyze existing repositories" action (ScanMode.REANALYZE_EXISTING). Optionally narrowed to one brand and/or a discovered-date window, matching whatever scope the actual reanalyze_existing run would use.',
  })
  @ApiQuery({ name: 'brandId', required: false })
  @ApiQuery({ name: 'discoveredFrom', required: false })
  @ApiQuery({ name: 'discoveredTo', required: false })
  async analyzedCount(
    @CurrentTenant() tenant: TenantContext,
    @Query('brandId') brandId?: string,
    @Query('discoveredFrom') discoveredFrom?: string,
    @Query('discoveredTo') discoveredTo?: string,
  ) {
    const count = await this.scansService.countAnalyzed(tenant.workspaceId, {
      brandId,
      discoveredFrom: discoveredFrom ? new Date(discoveredFrom) : undefined,
      discoveredTo: discoveredTo ? new Date(discoveredTo) : undefined,
    });
    return { count };
  }

  @Get('unassessed-findings-count')
  @ApiOperation({
    summary:
      'Count of existing findings never AI-assessed and eligible for a backfill - for the "Backfill AI assessments" action. Optionally narrowed to one brand and/or a discovered-date window.',
  })
  @ApiQuery({ name: 'brandId', required: false })
  @ApiQuery({ name: 'discoveredFrom', required: false })
  @ApiQuery({ name: 'discoveredTo', required: false })
  async unassessedFindingsCount(
    @CurrentTenant() tenant: TenantContext,
    @Query('brandId') brandId?: string,
    @Query('discoveredFrom') discoveredFrom?: string,
    @Query('discoveredTo') discoveredTo?: string,
  ) {
    const count = await this.scansService.countUnassessedFindings(
      tenant.workspaceId,
      {
        brandId,
        discoveredFrom: discoveredFrom ? new Date(discoveredFrom) : undefined,
        discoveredTo: discoveredTo ? new Date(discoveredTo) : undefined,
      },
    );
    return { count };
  }

  @Post('backfill-intent-assessments')
  @ApiOperation({
    summary:
      'Queues an AI intent assessment for up to maxFindings existing, never-assessed findings - the only way to get an AI score onto findings that predate this feature or were last seen "unchanged" (a plain rescan never triggers one). Optionally narrowed to one brand and/or a discovered-date window; hard-capped at 500 per call.',
  })
  async backfillIntentAssessments(
    @CurrentTenant() tenant: TenantContext,
    @Body()
    body: {
      brandId?: string;
      discoveredFrom?: string;
      discoveredTo?: string;
      maxFindings?: number;
    },
  ) {
    const queued = await this.scansService.backfillIntentAssessments(
      tenant.workspaceId,
      {
        brandId: body.brandId,
        discoveredFrom: body.discoveredFrom
          ? new Date(body.discoveredFrom)
          : undefined,
        discoveredTo: body.discoveredTo
          ? new Date(body.discoveredTo)
          : undefined,
        maxFindings: body.maxFindings,
      },
    );
    return { queued };
  }

  @Get('keyword-query-preview')
  @ApiOperation({
    summary:
      "The actual repo-search + code-search query strings buildQueryFamilies would run right now for each of a brand's own keywords - what the per-keyword discovery toggle shows/lets you edit before starting.",
  })
  @ApiQuery({ name: 'brandId', required: true })
  @ApiQuery({
    name: 'keyword',
    required: false,
    description:
      "Recompute just this one keyword's preview (e.g. after its own independent date range changed) instead of every keyword the brand has.",
  })
  @ApiQuery({ name: 'createdFrom', required: false })
  @ApiQuery({ name: 'createdTo', required: false })
  @ApiQuery({ name: 'pushedFrom', required: false })
  @ApiQuery({ name: 'pushedTo', required: false })
  async keywordQueryPreview(
    @CurrentTenant() tenant: TenantContext,
    @Query('brandId') brandId: string,
    @Query('keyword') keyword?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('pushedFrom') pushedFrom?: string,
    @Query('pushedTo') pushedTo?: string,
  ) {
    return this.scansService.previewKeywordQueries(
      tenant.workspaceId,
      brandId,
      {
        createdFrom,
        createdTo,
        pushedFrom,
        pushedTo,
        dateFilterMode:
          createdFrom || createdTo || pushedFrom || pushedTo ? 'or' : 'and',
      },
      { keyword },
    );
  }

  @Post('keyword-rotation/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Start (or restart with a new queue) the workspace's sequential keyword scheduler: runs exactly one keyword's discovery scan at a time, each getting the workspace's whole GitHub token budget for its own duration before handing off to the next keyword in the queue - can mix keywords from several companies. The alternative to the per-keyword watch toggle running every keyword concurrently and splitting that same budget N ways.",
  })
  startKeywordRotation(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: AuthUser,
    @Body() body: StartKeywordRotationDto,
  ) {
    return this.scansService.startKeywordRotation(tenant.workspaceId, user.id, {
      slots: body.slots,
      dateFilterMode: body.dateFilterMode,
      createdFrom: body.createdFrom,
      createdTo: body.createdTo,
      pushedFrom: body.pushedFrom,
      pushedTo: body.pushedTo,
    });
  }

  @Post('keyword-rotation/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Stop the workspace's sequential keyword scheduler",
  })
  stopKeywordRotation(@CurrentTenant() tenant: TenantContext) {
    return this.scansService.stopKeywordRotation(tenant.workspaceId);
  }

  @Post('keyword-rotation/add')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Add one or more keywords to the END of an already-running scheduler queue, without touching whichever keyword currently holds the turn or anything else already queued - they'll come up in their turn once the cycle reaches them. Requires the scheduler to already be running (use Start otherwise).",
  })
  addKeywordRotationSlots(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: AddKeywordRotationSlotsDto,
  ) {
    return this.scansService.addKeywordRotationSlots(
      tenant.workspaceId,
      body.slots,
    );
  }

  @Post('keyword-rotation/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Pause ONE queued keyword without touching the rest of the scheduler - if it's the one currently holding the turn, hands off immediately to the next non-paused keyword instead of waiting out its remaining duration.",
  })
  pauseKeywordRotationSlot(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: KeywordRotationSlotRefDto,
  ) {
    return this.scansService.pauseKeywordRotationSlot(
      tenant.workspaceId,
      body.brandId,
      body.keyword,
    );
  }

  @Post('keyword-rotation/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resume ONE previously paused keyword - rejoins the cycle on its next turn, or immediately restarts the scheduler from this keyword if the whole thing had stopped.',
  })
  resumeKeywordRotationSlot(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: KeywordRotationSlotRefDto,
  ) {
    return this.scansService.resumeKeywordRotationSlot(
      tenant.workspaceId,
      body.brandId,
      body.keyword,
    );
  }

  @Post('keyword-rotation/search-scope')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Change which GitHub search kind(s) ONE queued keyword runs - repository search only, code search only, or both (default). If it's the keyword currently holding the turn, its scan restarts immediately with the new choice instead of waiting for its next turn.",
  })
  setKeywordRotationSlotSearchScope(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: SetKeywordRotationSlotSearchScopeDto,
  ) {
    return this.scansService.setKeywordRotationSlotSearchScope(
      tenant.workspaceId,
      body.brandId,
      body.keyword,
      body.searchScope,
    );
  }

  @Post('keyword-rotation/continue-discovery')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Change whether ONE queued keyword resumes its queries from its own discovery cursor (true, default) or restarts every query at page 1 on every turn (false). If it's the keyword currently holding the turn, its scan restarts immediately with the new choice instead of waiting for its next turn.",
  })
  setKeywordRotationSlotContinueDiscovery(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: SetKeywordRotationSlotContinueDiscoveryDto,
  ) {
    return this.scansService.setKeywordRotationSlotContinueDiscovery(
      tenant.workspaceId,
      body.brandId,
      body.keyword,
      body.continueDiscovery,
    );
  }

  @Post('keyword-rotation/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Permanently remove ONE keyword from the queue, from any state - if it's the one currently holding the turn, cancels its scan (repos already discovered stay recorded) and hands off immediately to the next non-paused keyword.",
  })
  removeKeywordRotationSlot(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: KeywordRotationSlotRefDto,
  ) {
    return this.scansService.removeKeywordRotationSlot(
      tenant.workspaceId,
      body.brandId,
      body.keyword,
    );
  }

  @Get('keyword-rotation')
  @ApiOperation({
    summary:
      "Current state of the workspace's sequential keyword scheduler (null if never started) - which keyword/company currently holds the slot, how much time is left, and how many full cycles have completed.",
  })
  getKeywordRotation(@CurrentTenant() tenant: TenantContext) {
    return this.scansService.getKeywordRotationStatus(tenant.workspaceId);
  }

  @Get('active-by-keyword')
  @ApiOperation({
    summary:
      "Currently active (queued/running) keyword-scoped scans for one brand, keyed by keyword - powers the Brands page's per-keyword start/stop toggle",
  })
  @ApiQuery({ name: 'brandId', required: true })
  async activeByKeyword(
    @CurrentTenant() tenant: TenantContext,
    @Query('brandId') brandId: string,
  ) {
    return this.scansService.listActiveByKeyword(tenant.workspaceId, brandId);
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
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    description:
      'Only repos created on/after this date (YYYY-MM-DD). Repository search only.',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    description:
      'Only repos created on/before this date (YYYY-MM-DD). Repository search only.',
  })
  @ApiQuery({
    name: 'pushedFrom',
    required: false,
    description:
      'Only repos last pushed to on/after this date (YYYY-MM-DD) - filters by recent activity, independent of createdFrom/createdTo. Repository search only.',
  })
  @ApiQuery({
    name: 'pushedTo',
    required: false,
    description:
      'Only repos last pushed to on/before this date (YYYY-MM-DD). Repository search only.',
  })
  @ApiQuery({
    name: 'includeSeen',
    required: false,
    description:
      'Include repos this workspace has already seen (default: false, hidden).',
  })
  async customSearch(
    @CurrentTenant() tenant: TenantContext,
    @Query('q') q: string,
    @Query('page') page = '1',
    @Query('type') type: 'repositories' | 'code' = 'repositories',
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('pushedFrom') pushedFrom?: string,
    @Query('pushedTo') pushedTo?: string,
    @Query('includeSeen') includeSeen?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    if (
      type === 'code' &&
      (createdFrom || createdTo || pushedFrom || pushedTo)
    ) {
      throw new BadRequestException(
        'createdFrom/createdTo/pushedFrom/pushedTo only apply to repository search, not code search',
      );
    }
    const createdQualifier = buildCreatedQualifier(createdFrom, createdTo);
    const pushedQualifier = buildPushedQualifier(pushedFrom, pushedTo);
    const dateQualifiers = [createdQualifier, pushedQualifier]
      .filter(Boolean)
      .join(' ');
    const query = dateQualifiers ? `${q} ${dateQualifiers}` : q;
    const want = includeSeen === 'true';

    const result =
      type === 'code'
        ? await this.github.searchCode(query, p, 10, {
            workspaceId: tenant.workspaceId,
          })
        : await this.github.searchRepositories(query, p, 10, {
            workspaceId: tenant.workspaceId,
          });

    const { items, hiddenSeenCount } = await this.seenRepos.filterUnseen(
      tenant.workspaceId,
      result.items,
      want,
    );
    return { ...result, items, hiddenSeenCount };
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
