import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { ScanJob, ScanJobDocument } from './schemas/scan-job.schema';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../brands/schemas/monitored-brand.schema';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import { ScanQueueService } from '../queues/scan-queue.service';
import type { ManualScanOptions } from '../queues/scan-queue.service';
import { IncrementalScanService } from './incremental-scan.service';
import { GitHubService } from '../github/github.service';
import {
  FindingChangeType,
  FindingStatus,
  ScanJobStatus,
} from '../common/enums';
import { buildQueryFamilies } from './discovery/query-families';
import {
  KeywordRotationService,
  KeywordRotationSlotInput,
  KeywordRotationStatus,
  StartKeywordRotationOptions,
} from './keyword-rotation.service';

const ACTIVE_SCAN_STATUSES = [ScanJobStatus.QUEUED, ScanJobStatus.RUNNING];

/** Escapes regex metacharacters so free-text filter input (e.g. a language like "C++") is matched literally, not interpreted as a pattern. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class ScansService {
  constructor(
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    private readonly scanQueue: ScanQueueService,
    private readonly incremental: IncrementalScanService,
    private readonly github: GitHubService,
    private readonly keywordRotation: KeywordRotationService,
  ) {}

  /**
   * `status` restricts to specific ScanJobStatus values (e.g. the
   * queued/running pair) - added for the Scans page's "Currently running"
   * section, which used to just filter the general newest-20 history page
   * client-side for active rows. That silently broke (the whole section
   * would vanish even with a scan genuinely still running) the moment
   * enough OTHER scans got created afterward to push the active one off
   * page 1 - a real scenario here, since both the sequential scheduler's
   * own handoffs and each independently-watched keyword's auto-restart
   * (see ScanStateService.maybeRestartKeywordWatch) keep creating new scan
   * rows over time. Filtering server-side on status (indexed:
   * {workspaceId, status}) instead of on recency means an active scan is
   * found regardless of how much newer history has piled up since it started.
   */
  list(
    workspaceId: string,
    page = 1,
    limit = 20,
    options: { status?: ScanJobStatus[] } = {},
  ) {
    const skip = (page - 1) * limit;
    const filter: FilterQuery<ScanJobDocument> = {
      workspaceId: new Types.ObjectId(workspaceId),
    };
    if (options.status && options.status.length > 0) {
      filter.status = { $in: options.status };
    }
    return Promise.all([
      this.scanModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.scanModel.countDocuments(filter).exec(),
    ]).then(([data, total]) => ({ data, total, page, limit }));
  }

  async findById(workspaceId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.scanModel
      .findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) })
      .lean()
      .exec();
  }

  /** Enqueue async scan — returns persisted job immediately (HTTP 202). */
  async startManualScan(
    workspaceId: string,
    userId: string,
    options: ManualScanOptions = {},
  ) {
    return this.scanQueue.enqueueManualScan(workspaceId, userId, options);
  }

  async cancelScan(workspaceId: string, scanJobId: string) {
    return this.scanQueue.cancelScan(workspaceId, scanJobId);
  }

  async retryScan(workspaceId: string, scanJobId: string, userId: string) {
    return this.scanQueue.retryFailedScan(workspaceId, scanJobId, userId);
  }

  /** Looks up a workspace-owned repository by its Mongo _id - shared by both branch-analysis endpoints below. Throws if it doesn't exist or belongs to another workspace. */
  private async getOwnedRepository(workspaceId: string, repositoryId: string) {
    if (!Types.ObjectId.isValid(repositoryId)) {
      throw new NotFoundException('Repository not found');
    }
    const repo = await this.repoModel
      .findOne({
        _id: repositoryId,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .lean()
      .exec();
    if (!repo) throw new NotFoundException('Repository not found');
    return repo;
  }

  /**
   * Every branch this repository actually has on GitHub, not just its
   * default one - GitHub's search index only ever covers the default
   * branch, so this is the only way to even discover a side branch exists.
   * Flags which one is the default so the UI can label it.
   */
  async listRepositoryBranches(workspaceId: string, repositoryId: string) {
    const repo = await this.getOwnedRepository(workspaceId, repositoryId);
    const branches = await this.github.listBranches(repo.owner, repo.name);
    return branches.map((b) => ({
      ...b,
      isDefault: b.name === repo.defaultBranch,
    }));
  }

  /**
   * Starts an on-demand clone+scan of one specific branch of one
   * already-known repository - see ScanMode.BRANCH_ANALYSIS. Every enabled
   * brand is passed through (same as a normal scan) so the detection
   * engine can attribute the finding to whichever one actually matches,
   * not just whichever brand this repo happened to be discovered under.
   */
  async startBranchAnalysis(
    workspaceId: string,
    userId: string,
    repositoryId: string,
    branch: string,
  ) {
    const repo = await this.getOwnedRepository(workspaceId, repositoryId);
    const brands = await this.brandModel
      .find({ workspaceId: new Types.ObjectId(workspaceId), enabled: true })
      .lean()
      .exec();
    return this.scanQueue.startBranchAnalysis(
      workspaceId,
      userId,
      {
        repositoryDbId: String(repo._id),
        githubId: repo.githubId,
        fullName: repo.fullName,
      },
      brands.map((b) => ({
        id: String(b._id),
        name: b.name,
        aliases: b.aliases,
        trustedGithubOwners: b.trustedGithubOwners,
        keywords: b.keywords,
      })),
      branch,
    );
  }

  /** How many repos a discoveryOnly scan found and saved but haven't been analyzed yet - powers the "Analyze discovered repositories" button's count. Optionally narrowed to one brand and/or a discovered-date window, matching whatever scope the actual analyze_pending run would use. */
  countPendingAnalysis(
    workspaceId: string,
    options: {
      brandId?: string;
      discoveredFrom?: Date;
      discoveredTo?: Date;
    } = {},
  ): Promise<number> {
    return this.incremental.countPendingAnalysis(workspaceId, options);
  }

  countAnalyzed(
    workspaceId: string,
    options: {
      brandId?: string;
      discoveredFrom?: Date;
      discoveredTo?: Date;
    } = {},
  ): Promise<number> {
    return this.incremental.countAnalyzed(workspaceId, options);
  }

  /**
   * Matches exactly the findings a backfillIntentAssessments run with the
   * same options would queue - external-origin only (mirrors the live
   * pipeline trigger's own exclusion of internal audits, which the intent
   * prompt isn't shaped for), never already AI-scored, and never a
   * dismissed false positive (no value re-scoring something an analyst
   * already ruled out).
   */
  private buildUnassessedFindingsFilter(
    workspaceId: string,
    options: { brandId?: string; discoveredFrom?: Date; discoveredTo?: Date },
  ): FilterQuery<FindingDocument> {
    const filter: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
      origin: 'external',
      scoringSource: { $ne: 'ai' },
      status: { $ne: FindingStatus.FALSE_POSITIVE },
    };
    if (options.brandId) filter.brandId = new Types.ObjectId(options.brandId);
    if (options.discoveredFrom || options.discoveredTo) {
      const range: Record<string, Date> = {};
      if (options.discoveredFrom) range.$gte = options.discoveredFrom;
      if (options.discoveredTo) range.$lte = options.discoveredTo;
      filter.createdAt = range;
    }
    return filter;
  }

  /** How many existing findings are eligible for an AI backfill right now - powers the "Backfill AI assessments" button's live count. */
  countUnassessedFindings(
    workspaceId: string,
    options: {
      brandId?: string;
      discoveredFrom?: Date;
      discoveredTo?: Date;
    } = {},
  ): Promise<number> {
    return this.findingModel
      .countDocuments(this.buildUnassessedFindingsFilter(workspaceId, options))
      .exec();
  }

  /**
   * Queues an AI intent assessment for up to `maxFindings` existing
   * findings that have never been assessed - the only way to get an AI
   * score onto a finding that predates this feature, since a plain rescan
   * of an already-analyzed repo just reproduces the same finding
   * ("unchanged"), which deliberately never triggers an assessment (see
   * DetectionProcessingProcessor). Hard-capped at 500 per call regardless
   * of what's requested, so one click can't accidentally queue thousands
   * of calls against a free-tier LLM quota.
   */
  async backfillIntentAssessments(
    workspaceId: string,
    options: {
      brandId?: string;
      discoveredFrom?: Date;
      discoveredTo?: Date;
      maxFindings?: number;
    } = {},
  ): Promise<number> {
    const limit = Math.min(Math.max(1, options.maxFindings || 50), 500);
    const findings = await this.findingModel
      .find(this.buildUnassessedFindingsFilter(workspaceId, options))
      .select('_id repositoryId')
      .limit(limit)
      .lean()
      .exec();
    for (const f of findings) {
      await this.scanQueue.enqueueIntentAssessment({
        workspaceId,
        repositoryId: String(f.repositoryId),
        findingId: String(f._id),
      });
    }
    return findings.length;
  }

  /**
   * Every repository this workspace has discovered (whether or not it's
   * been content-analyzed yet) - the browsable counterpart to
   * countPendingAnalysis's bare number. Optionally narrowed to only
   * pending-analysis candidates or by a fullName/owner text match.
   *
   * Each repo is enriched with WHICH brand it was found for and WHERE the
   * match actually is:
   *  - If it's been content-analyzed and has a Finding, that Finding's own
   *    brandName/brandMatchEvidence is authoritative (exact location - repo
   *    name, description, topics, README, a specific file/line, a commit
   *    message/author - plus the literal matched text).
   *  - Otherwise (still pendingAnalysis - discovered but never opened/
   *    cloned) there's no byte-level evidence yet; falls back to the brand
   *    + keyword the discovering scan was scoped to, labeled unconfirmed.
   */
  async listRepositories(
    workspaceId: string,
    page = 1,
    limit = 20,
    options: {
      pendingAnalysis?: boolean;
      search?: string;
      /** Only repos whose discovering scan was scoped to this exact company - see Repository.discoveryBrandId. */
      brandId?: string;
      /** Only repos whose discovering scan was scoped to this exact keyword - powers the sequential scheduler's per-keyword "View" link. Requires brandId (a keyword string alone isn't unique across companies). */
      keyword?: string;
      /** Exact (case-insensitive) match on GitHub's reported primary language. */
      language?: string;
      /** Where the brand match was found - see attachMatchInfo. Same value space as Finding.brandMatchEvidence.location for an analyzed repo, or Repository.discoveryMatchedField for one that's still only discovery-evidenced. */
      matchLocation?: string;
      /** When WE first recorded this repo (Repository.createdAt) - not any GitHub timestamp. */
      discoveredFrom?: Date;
      discoveredTo?: Date;
      githubCreatedFrom?: Date;
      githubCreatedTo?: Date;
      pushedFrom?: Date;
      pushedTo?: Date;
      lastScannedFrom?: Date;
      lastScannedTo?: Date;
    } = {},
  ) {
    const skip = (page - 1) * limit;
    const filter: FilterQuery<RepositoryDocument> = {
      workspaceId: new Types.ObjectId(workspaceId),
      // The Repositories page is specifically "what did keyword/GitHub
      // search discover" - an internal audit enumerates a brand's own
      // trustedGithubOwners directly (no keyword involved at all), which is
      // a fundamentally different listing (surfaced on the scan's own
      // progress/detail page instead), not a repo this page's search/brand/
      // keyword filters below have any meaningful way to describe.
      origin: 'external',
    };
    if (options.pendingAnalysis !== undefined) {
      filter.pendingAnalysis = options.pendingAnalysis;
    }
    const search = options.search?.trim();
    if (search) {
      filter.fullName = { $regex: search, $options: 'i' };
    }
    if (options.brandId && Types.ObjectId.isValid(options.brandId)) {
      filter.discoveryBrandId = new Types.ObjectId(options.brandId);
    }
    if (options.keyword?.trim()) {
      filter.discoveryKeyword = options.keyword.trim();
    }
    if (options.language?.trim()) {
      filter.language = {
        $regex: `^${escapeRegex(options.language.trim())}$`,
        $options: 'i',
      };
    }
    const dateRange = (from?: Date, to?: Date) => {
      const range: Record<string, Date> = {};
      if (from) range.$gte = from;
      if (to) range.$lte = to;
      return Object.keys(range).length > 0 ? range : undefined;
    };
    const createdAtRange = dateRange(
      options.discoveredFrom,
      options.discoveredTo,
    );
    if (createdAtRange) filter.createdAt = createdAtRange;
    const githubCreatedRange = dateRange(
      options.githubCreatedFrom,
      options.githubCreatedTo,
    );
    if (githubCreatedRange) filter.githubCreatedAt = githubCreatedRange;
    const pushedRange = dateRange(options.pushedFrom, options.pushedTo);
    if (pushedRange) filter.githubPushedAt = pushedRange;
    const lastScannedRange = dateRange(
      options.lastScannedFrom,
      options.lastScannedTo,
    );
    if (lastScannedRange) filter.lastScannedAt = lastScannedRange;
    if (options.matchLocation?.trim()) {
      // matchLocation isn't stored directly - it's resolved at read time in
      // attachMatchInfo, from a Finding's evidence when one exists, else
      // from the repo's own discoveryMatchedField. Mirror that same
      // precedence here: a repo with ANY finding always shows that
      // finding's location (never discoveryMatchedField, even if it also
      // happens to be set), so it only counts toward this filter via the
      // Finding branch.
      const ws = new Types.ObjectId(workspaceId);
      const location = options.matchLocation.trim();
      const [locationFindingRepoIds, anyFindingRepoIds] = await Promise.all([
        this.findingModel
          .find({ workspaceId: ws, 'brandMatchEvidence.location': location })
          .distinct('repositoryId')
          .exec(),
        this.findingModel
          .find({ workspaceId: ws })
          .distinct('repositoryId')
          .exec(),
      ]);
      filter.$or = [
        { _id: { $in: locationFindingRepoIds } },
        {
          discoveryMatchedField: location,
          _id: { $nin: anyFindingRepoIds },
        },
      ];
    }
    const [data, total] = await Promise.all([
      this.repoModel
        .find(filter)
        // Newest DISCOVERY first (when this workspace's own scans first/most
        // recently found or re-touched it), not GitHub's own push activity -
        // a repo pushed to yesterday by its original devs but only found by
        // one of our scans just now should show up at the top; a repo we
        // discovered days ago but that happens to have a recent GitHub push
        // should not bury what we actually just found.
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.repoModel.countDocuments(filter).exec(),
    ]);

    const enriched = await this.attachMatchInfo(workspaceId, data);
    return { data: enriched, total, page, limit };
  }

  /** Distinct, non-empty GitHub languages seen among this workspace's keyword-discovered repos - powers the Repositories page's Language filter dropdown so it only ever offers values that actually exist, instead of a free-text box users have to guess the exact spelling/casing of. */
  async listDistinctRepositoryLanguages(
    workspaceId: string,
  ): Promise<string[]> {
    const languages = await this.repoModel
      .distinct('language', {
        workspaceId: new Types.ObjectId(workspaceId),
        origin: 'external',
        language: { $nin: ['', null] },
      })
      .exec();
    return languages.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Two different notions of "this repo recently changed," both scoped to
   * keyword-discovered repos (same origin:'external' convention as the rest
   * of this page - see listRepositories):
   *  - recentPushes: the repo's code itself changed on GitHub recently
   *    (githubPushedAt), regardless of whether any of our scans have
   *    touched it since - "what's actively being worked on."
   *  - recentFindingChanges: one of OUR rescans just turned up something
   *    different (Finding.lastChangeType is 'new' or 'reopened', not
   *    'unchanged') - "what our own analysis flagged," independent of how
   *    much code actually moved. A repo can appear in neither, either, or
   *    both lists.
   */
  async getRecentChanges(
    workspaceId: string,
    options: { days?: number; limit?: number; brandId?: string } = {},
  ) {
    const days = options.days && options.days > 0 ? options.days : 7;
    const limit = Math.min(
      options.limit && options.limit > 0 ? options.limit : 8,
      200,
    );
    const ws = new Types.ObjectId(workspaceId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const brand =
      options.brandId && Types.ObjectId.isValid(options.brandId)
        ? new Types.ObjectId(options.brandId)
        : undefined;

    const [recentPushes, recentFindingChanges] = await Promise.all([
      this.repoModel
        .find({
          workspaceId: ws,
          origin: 'external',
          githubPushedAt: { $gte: since },
          ...(brand ? { discoveryBrandId: brand } : {}),
        })
        .sort({ githubPushedAt: -1 })
        .limit(limit)
        .select('fullName url owner name githubPushedAt language stars')
        .lean()
        .exec(),
      this.findingModel
        .find({
          workspaceId: ws,
          origin: 'external',
          lastChangeType: {
            $in: [FindingChangeType.NEW, FindingChangeType.REOPENED],
          },
          lastSeenAt: { $gte: since },
          ...(brand ? { brandId: brand } : {}),
        })
        .sort({ lastSeenAt: -1 })
        .limit(limit)
        .select(
          'repositoryId brandName severity summary lastChangeType lastSeenAt',
        )
        .populate('repositoryId', 'fullName url')
        .lean()
        .exec(),
    ]);

    return {
      recentPushes,
      recentFindingChanges: recentFindingChanges
        // A finding whose repo was since deleted (rare - workspace reset,
        // manual cleanup) has nothing left to populate; drop it rather than
        // show a dead link with no repo name.
        .filter((f) => f.repositoryId)
        .map((f) => ({
          findingId: f._id,
          repository: f.repositoryId,
          brandName: f.brandName,
          severity: f.severity,
          summary: f.summary,
          changeType: f.lastChangeType,
          lastSeenAt: f.lastSeenAt,
        })),
    };
  }

  /**
   * Batch-resolves "which brand, matched where" for a page of repos - one
   * Finding query and one ScanJob+Brand lookup for the whole page, not one
   * per repo. See listRepositories.
   */
  private async attachMatchInfo(
    workspaceId: string,
    repos: Array<
      Record<string, unknown> & {
        _id: Types.ObjectId;
        lastScanJobId?: Types.ObjectId;
      }
    >,
  ) {
    if (repos.length === 0) return repos;
    const repoIds = repos.map((r) => r._id);

    const findings = await this.findingModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        repositoryId: { $in: repoIds },
      })
      .select('repositoryId brandName brandMatchEvidence riskScore')
      .sort({ riskScore: -1 })
      .lean()
      .exec();
    // First (highest-riskScore, thanks to the sort above) finding per repo wins.
    const findingByRepo = new Map<string, (typeof findings)[number]>();
    for (const f of findings) {
      const key = String(f.repositoryId);
      if (!findingByRepo.has(key)) findingByRepo.set(key, f);
    }

    const unconfirmedScanJobIds = [
      ...new Set(
        repos
          .filter((r) => !findingByRepo.has(String(r._id)) && r.lastScanJobId)
          .map((r) => String(r.lastScanJobId)),
      ),
    ];
    const scanJobs = unconfirmedScanJobIds.length
      ? await this.scanModel
          .find({ _id: { $in: unconfirmedScanJobIds } })
          .select('scopeBrandId scopeKeyword')
          .lean()
          .exec()
      : [];
    const scanJobById = new Map(scanJobs.map((s) => [String(s._id), s]));
    // additionalBrandMatches (see Repository schema) names every OTHER
    // brand this repo also matched, regardless of whether it's ever been
    // content-analyzed - gathered alongside scopeBrandId in the SAME
    // batched lookup below rather than a second round trip.
    const additionalMatchesByRepo = new Map<
      string,
      Array<{ brandId: Types.ObjectId; keyword?: string }>
    >();
    for (const repo of repos) {
      const matches = (
        repo as {
          additionalBrandMatches?: Array<{
            brandId: Types.ObjectId;
            keyword?: string;
          }>;
        }
      ).additionalBrandMatches;
      if (matches?.length) {
        additionalMatchesByRepo.set(String(repo._id), matches);
      }
    }
    const brandIds = [
      ...new Set([
        ...scanJobs
          .map((s) => s.scopeBrandId)
          .filter(Boolean)
          .map(String),
        ...[...additionalMatchesByRepo.values()]
          .flat()
          .map((m) => String(m.brandId)),
        // repo.discoveryBrandId is the permanent record of which brand's
        // scan first found this repo (see Repository.discoveryBrandId) -
        // included here too since the map below now reads it directly
        // instead of only trusting whichever scan lastScanJobId happens to
        // point at right now, which can drift to a later, brand-agnostic
        // rescan (see the matchedBrand/matchKeyword comment further down).
        ...repos
          .map(
            (r) =>
              (r as { discoveryBrandId?: Types.ObjectId }).discoveryBrandId,
          )
          .filter(Boolean)
          .map(String),
      ]),
    ];
    const brands = brandIds.length
      ? await this.brandModel
          .find({ _id: { $in: brandIds } })
          .select('name')
          .lean()
          .exec()
      : [];
    const brandNameById = new Map(brands.map((b) => [String(b._id), b.name]));

    return repos.map((repo) => {
      // Every OTHER brand this repo also matched, by name - see
      // Repository.additionalBrandMatches' doc comment for why this is
      // otherwise silently lost. Attached the same way regardless of
      // whether the repo below turns out to have a confirmed Finding or
      // is still only discovery-evidenced.
      const additionalBrands = (
        additionalMatchesByRepo.get(String(repo._id)) || []
      )
        .map((m) => ({
          name: brandNameById.get(String(m.brandId)),
          keyword: m.keyword,
        }))
        .filter((m): m is { name: string; keyword: string | undefined } =>
          Boolean(m.name),
        );

      const finding = findingByRepo.get(String(repo._id));
      if (finding) {
        return {
          ...repo,
          matchedBrand: finding.brandName,
          matchConfirmed: true,
          matchLocation: finding.brandMatchEvidence?.location,
          matchedText: finding.brandMatchEvidence?.matchedText,
          matchFilePath: finding.brandMatchEvidence?.filePath,
          matchLineNumber: finding.brandMatchEvidence?.lineNumber,
          additionalBrands,
        };
      }
      const scanJob = repo.lastScanJobId
        ? scanJobById.get(String(repo.lastScanJobId))
        : undefined;
      // Prefer the repo's own discoveryBrandId/discoveryKeyword - stamped
      // once at discovery time and never touched again (see Repository.
      // discoveryKeyword's doc comment) - over joining through
      // lastScanJobId's scopeBrandId/scopeKeyword. That join used to be the
      // only source here, but lastScanJobId is overwritten by ANY later
      // scan that re-touches this repo (an incremental rescan, a
      // brand-agnostic sweep, ANALYZE_PENDING, ...), which would silently
      // blank out a correctly-discovered keyword the moment some other,
      // unrelated scan happened to run against the same repo afterward.
      // Falls back to the scanJob join only for older records written
      // before discoveryBrandId/discoveryKeyword existed.
      const discoveryBrandId = (repo as { discoveryBrandId?: Types.ObjectId })
        .discoveryBrandId;
      const matchedBrand = discoveryBrandId
        ? brandNameById.get(String(discoveryBrandId))
        : scanJob?.scopeBrandId
          ? brandNameById.get(String(scanJob.scopeBrandId))
          : undefined;
      return {
        ...repo,
        matchedBrand,
        matchConfirmed: false,
        matchKeyword:
          (repo as { discoveryKeyword?: string }).discoveryKeyword ||
          scanJob?.scopeKeyword,
        // Best-effort, captured for free at discovery time (see
        // GitHubSearchProcessor.resolveDiscoveryMatchEvidence) - not a real
        // Finding's evidence, but real enough to say WHERE, not just THAT,
        // this repo matched, well before it's ever actually analyzed.
        matchLocation:
          (repo as { discoveryMatchedField?: string }).discoveryMatchedField ||
          undefined,
        matchFilePath:
          (repo as { discoveryMatchedPath?: string }).discoveryMatchedPath ||
          undefined,
        matchedText:
          (repo as { discoveryMatchedText?: string }).discoveryMatchedText ||
          undefined,
        additionalBrands,
      };
    });
  }

  /**
   * Every keyword-scoped scan this brand has ever run, keyed by keyword -
   * powers the Brands page's per-keyword toggle (current on/off state, live
   * timer) AND its discovered-repo counts. `reposDiscovered` /
   * `reposPendingAnalysis` are summed across EVERY run of that keyword
   * (queued/running/completed/cancelled/failed alike), not just the most
   * recent one - a keyword that discovered 40 repos across three earlier
   * runs and is now off must still show 40, not reset to 0 the moment its
   * current run stops. `status`/`isActive`/`scanJobId`/`startedAt` still
   * reflect only the MOST RECENT run, since those describe "is it on right
   * now," which only ever has one true answer.
   */
  async listActiveByKeyword(
    workspaceId: string,
    brandId: string,
  ): Promise<
    Record<
      string,
      {
        scanJobId: string;
        status: string;
        isActive: boolean;
        startedAt?: Date;
        reposDiscovered: number;
        reposPendingAnalysis: number;
        /** Set (future timestamp, ms) while this scan is mid rate-limit
         * pacing delay and waiting on its next GitHub request slot - still
         * genuinely running, not stalled or stopped. See
         * GitHubService.getScanPausedUntil / delayJobForGitHubQuota. */
        pausedUntil?: number;
        /**
         * The most recent run's own status message (e.g. "Analyzed 0
         * repositories (0 skipped, 0 rescanned)") - lets the UI show WHY a
         * keyword's toggle is off: a real error, vs. legitimately finding
         * zero new results (a narrow keyword, or every match already
         * discovered by an earlier scan), which otherwise looks identical
         * to "broken" from the toggle state alone.
         */
        lastMessage?: string;
        lastError?: string;
        /**
         * Set (future timestamp, ms) while QUEUED means "deliberately
         * cooling down before its next automatic keyword-watch cycle," not
         * "waiting behind a worker backlog" - see
         * ScanStateService.maybeRestartKeywordWatch. Without this, a
         * cooldown and a genuine backlog look identical in the UI.
         */
        scheduledFor?: number;
      }
    >
  > {
    if (!Types.ObjectId.isValid(brandId)) return {};
    const rows = await this.scanModel.aggregate<{
      _id: string;
      totalDiscovered: number;
      totalPendingAnalysis: number;
      mostRecent: {
        _id: Types.ObjectId;
        status: string;
        startedAt?: Date;
        message?: string;
        error?: string;
        scheduledFor?: Date;
      };
    }>([
      {
        $match: {
          workspaceId: new Types.ObjectId(workspaceId),
          scopeBrandId: new Types.ObjectId(brandId),
          scopeKeyword: { $exists: true, $ne: null },
        },
      },
      // Newest-first so $first below picks the most recent run per keyword.
      { $sort: { _id: -1 } },
      {
        $group: {
          _id: '$scopeKeyword',
          totalDiscovered: { $sum: { $ifNull: ['$reposDiscovered', 0] } },
          totalPendingAnalysis: {
            $sum: { $ifNull: ['$reposPendingAnalysis', 0] },
          },
          mostRecent: { $first: '$$ROOT' },
        },
      },
    ]);

    const byKeyword: Record<
      string,
      {
        scanJobId: string;
        status: string;
        isActive: boolean;
        startedAt?: Date;
        reposDiscovered: number;
        reposPendingAnalysis: number;
        pausedUntil?: number;
        lastMessage?: string;
        lastError?: string;
        scheduledFor?: number;
      }
    > = {};
    for (const row of rows) {
      const keyword = row._id;
      if (!keyword) continue;
      const isActive = ACTIVE_SCAN_STATUSES.includes(
        row.mostRecent.status as ScanJobStatus,
      );
      const scheduledForMs = row.mostRecent.scheduledFor
        ? new Date(row.mostRecent.scheduledFor).getTime()
        : undefined;
      byKeyword[keyword] = {
        scanJobId: String(row.mostRecent._id),
        status: row.mostRecent.status,
        isActive,
        startedAt: row.mostRecent.startedAt,
        reposDiscovered: row.totalDiscovered || 0,
        reposPendingAnalysis: row.totalPendingAnalysis || 0,
        // Not yet actually started (no startedAt) and still scheduled in
        // the future - this is a keyword-watch cooldown, not a backlog.
        ...(isActive &&
        !row.mostRecent.startedAt &&
        scheduledForMs &&
        scheduledForMs > Date.now()
          ? { scheduledFor: scheduledForMs }
          : {}),
        // Only meaningful once a run has actually finished - while active,
        // the toggle's own live status already says everything worth
        // saying, and showing a STALE previous run's message here would be
        // actively misleading.
        ...(isActive
          ? {}
          : {
              lastMessage: row.mostRecent.message || undefined,
              lastError: row.mostRecent.error || undefined,
            }),
      };
    }
    await Promise.all(
      Object.values(byKeyword)
        .filter((entry) => entry.isActive)
        .map(async (entry) => {
          const pausedUntil = await this.github.getScanPausedUntil(
            entry.scanJobId,
          );
          if (pausedUntil) entry.pausedUntil = pausedUntil;
        }),
    );
    return byKeyword;
  }

  /**
   * What buildQueryFamilies would actually search for each of the brand's
   * own keywords, right now, given this exact date range - the same
   * repo-search / code-search query strings a real onlyKeyword-scoped scan
   * would run. Lets the per-keyword toggle UI show (and the user edit) the
   * real query instead of it being an opaque black box. Pass `keyword` to
   * recompute just ONE keyword's preview (e.g. after its own, independent
   * date range changes) instead of every keyword the brand has - each
   * keyword's date range is fully independent of the others, so there's no
   * shared result to reuse across them.
   */
  async previewKeywordQueries(
    workspaceId: string,
    brandId: string,
    dateRange: {
      createdFrom?: string;
      createdTo?: string;
      pushedFrom?: string;
      pushedTo?: string;
      dateFilterMode?: 'and' | 'or';
    } = {},
    options: { keyword?: string } = {},
  ): Promise<Record<string, { repoQuery: string; codeQuery: string }>> {
    if (!Types.ObjectId.isValid(brandId)) return {};
    const brand = await this.brandModel
      .findOne({ _id: brandId, workspaceId: new Types.ObjectId(workspaceId) })
      .select('name aliases keywords trustedGithubOwners')
      .lean()
      .exec();
    if (!brand) return {};

    const keywords = options.keyword
      ? (brand.keywords || []).filter((k) => k === options.keyword)
      : brand.keywords || [];

    const result: Record<string, { repoQuery: string; codeQuery: string }> = {};
    for (const keyword of keywords) {
      const specs = buildQueryFamilies([brand], {
        enableCodeSearch: true,
        scopedToBrand: true,
        onlyKeyword: keyword,
        createdFrom: dateRange.createdFrom,
        createdTo: dateRange.createdTo,
        pushedFrom: dateRange.pushedFrom,
        pushedTo: dateRange.pushedTo,
        dateFilterMode: dateRange.dateFilterMode,
      });
      const repoSpec = specs.find((s) => s.family === 'brand-keyword-custom');
      const codeSpec = specs.find(
        (s) => s.family === 'brand-keyword-custom-code',
      );
      result[keyword] = {
        repoQuery: repoSpec?.query || '',
        codeQuery: codeSpec?.query || '',
      };
    }
    return result;
  }

  startKeywordRotation(
    workspaceId: string,
    userId: string,
    options: StartKeywordRotationOptions,
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.start(workspaceId, userId, options);
  }

  stopKeywordRotation(
    workspaceId: string,
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.stop(workspaceId);
  }

  addKeywordRotationSlots(
    workspaceId: string,
    slots: KeywordRotationSlotInput[],
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.addSlots(workspaceId, slots);
  }

  pauseKeywordRotationSlot(
    workspaceId: string,
    brandId: string,
    keyword: string,
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.pauseSlot(workspaceId, brandId, keyword);
  }

  resumeKeywordRotationSlot(
    workspaceId: string,
    brandId: string,
    keyword: string,
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.resumeSlot(workspaceId, brandId, keyword);
  }

  setKeywordRotationSlotSearchScope(
    workspaceId: string,
    brandId: string,
    keyword: string,
    searchScope: 'both' | 'repositories' | 'code',
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.setSlotSearchScope(
      workspaceId,
      brandId,
      keyword,
      searchScope,
    );
  }

  setKeywordRotationSlotContinueDiscovery(
    workspaceId: string,
    brandId: string,
    keyword: string,
    continueDiscovery: boolean,
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.setSlotContinueDiscovery(
      workspaceId,
      brandId,
      keyword,
      continueDiscovery,
    );
  }

  removeKeywordRotationSlot(
    workspaceId: string,
    brandId: string,
    keyword: string,
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.removeSlot(workspaceId, brandId, keyword);
  }

  getKeywordRotationStatus(
    workspaceId: string,
  ): Promise<KeywordRotationStatus | null> {
    return this.keywordRotation.getStatus(workspaceId);
  }
}
