import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import {
  QUEUE_SCAN_ORCHESTRATOR,
  ScanOrchestratorJobData,
} from '../queue.constants';
import { ScanQueueService } from '../scan-queue.service';
import { ScanStateService } from '../../scans/scan-state.service';
import { ScanPipelineService } from '../../scans/scan-pipeline.service';
import { IncrementalScanService } from '../../scans/incremental-scan.service';
import { DiscoveryCursorService } from '../../scans/discovery-cursor.service';
import {
  GitHubService,
  isGitHubClientError,
} from '../../github/github.service';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../../brands/schemas/monitored-brand.schema';
import {
  Keyword,
  KeywordDocument,
} from '../../keywords/schemas/keyword.schema';
import { ScanJob, ScanJobDocument } from '../../scans/schemas/scan-job.schema';
import {
  SearchQuerySpec,
  buildDateQualifierVariants,
  groupTopPhrasesByBrand,
  repoMatchesActivityWindow,
} from '../../scans/discovery/query-families';
import {
  DistinctiveContentString,
  DistinctiveContentStringDocument,
} from '../../fingerprints/schemas/distinctive-content-string.schema';
import {
  safeJobError,
  withJobTimeout,
  sharedWorkerTuning,
} from '../queue.utils';
import { delayJobForGitHubQuota } from '../github-job.utils';
import { ScanCheckpointStage, ScanMode } from '../../common/enums';

@Processor(QUEUE_SCAN_ORCHESTRATOR, {
  concurrency: Number(process.env.WORKER_CONCURRENCY_ORCHESTRATOR || 2),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
  ...sharedWorkerTuning(),
})
export class ScanOrchestratorProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanOrchestratorProcessor.name);

  constructor(
    private readonly scanQueue: ScanQueueService,
    private readonly scanState: ScanStateService,
    private readonly pipeline: ScanPipelineService,
    private readonly incremental: IncrementalScanService,
    private readonly discoveryCursor: DiscoveryCursorService,
    private readonly github: GitHubService,
    private readonly config: ConfigService,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    @InjectModel(Keyword.name)
    private readonly keywordModel: Model<KeywordDocument>,
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    // Optional (defaults to null), matching ScanPipelineService's
    // knownSecretModel pattern - genuinely absent only in tests that don't
    // exercise this path; production DI always provides it. When null, the
    // distinctive-content query family is simply skipped (no phrases to bait
    // with), same as a brand with no ingested reference content yet.
    @InjectModel(DistinctiveContentString.name)
    private readonly contentStringModel: Model<DistinctiveContentStringDocument> | null = null,
  ) {
    super();
  }

  /** Top distinctive phrases per requested brand, most-distinctive first - empty when the model is unavailable or no brands were given. */
  private async fetchDistinctivePhrasesByBrand(
    workspaceId: string,
    brandIds: unknown[],
    limit = 5,
  ): Promise<Map<string, string[]>> {
    if (!this.contentStringModel || brandIds.length === 0) return new Map();
    const rows = await this.contentStringModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        brandId: { $in: brandIds },
      })
      .sort({ significantWordCount: -1 })
      .select({ brandId: 1, text: 1 })
      // Safety cap on total rows fetched regardless of brand count - the
      // per-brand top-N slicing happens in groupTopPhrasesByBrand below.
      .limit(500)
      .lean()
      .exec();
    return groupTopPhrasesByBrand(rows, limit);
  }

  /**
   * Claims, looks up, and bulk-enqueues repository-analysis jobs for a batch
   * of already-known githubIds - used by FAILED_ONLY/ANALYZE_PENDING, which
   * each get their FULL candidate id list upfront (unlike GitHubSearchProcessor,
   * which claims one page of ~100 at a time as GitHub returns them). Chunked
   * so a backlog of many thousands of repos still only costs a handful of
   * Mongo/Redis round-trips instead of several PER repo - at real scale (a
   * brand with 10k+ discovered-but-unanalyzed repos, say), the old one-at-a-
   * time loop made simply *enqueueing* the work slower than the analysis
   * itself, which could look indistinguishable from repos silently being
   * dropped. Returns how many were actually enqueued.
   */
  private async bulkEnqueueAnalysis(input: {
    workspaceId: string;
    scanJobId: string;
    githubIds: number[];
    maxRepos: number;
    mode: ScanMode;
    rulesetVersion: string;
    brandRefs: Array<{
      id: string;
      name: string;
      aliases: string[];
      trustedGithubOwners?: string[];
      keywords?: string[];
    }>;
    forceFullScan: boolean;
    resumed?: boolean;
    internalAudit: boolean;
    priority: number;
  }): Promise<number> {
    const CHUNK_SIZE = 500;
    let enqueued = 0;

    for (let i = 0; i < input.githubIds.length; i += CHUNK_SIZE) {
      const chunk = input.githubIds.slice(i, i + CHUNK_SIZE);
      const claimed = await this.incremental.claimManyForAnalysis(
        input.scanJobId,
        chunk,
        input.maxRepos,
      );
      if (claimed.length === 0) continue;

      const repos = await this.incremental.findManyByGithubIds(
        input.workspaceId,
        claimed,
      );
      const byId = new Map(repos.map((r) => [r.githubId, r]));

      // A claimed id with no matching Repository doc (deleted/never
      // persisted) must be un-claimed, or it'd sit in pendingGithubIds
      // forever without ever actually being analyzed or retried.
      const missing = claimed.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        await this.scanModel.findByIdAndUpdate(input.scanJobId, {
          $pull: { 'checkpoint.pendingGithubIds': { $in: missing } },
        });
      }

      const jobs = claimed
        .filter((id) => byId.has(id))
        .map((id) => {
          const repo = byId.get(id)!;
          return {
            workspaceId: input.workspaceId,
            scanJobId: input.scanJobId,
            mode: input.mode,
            forceFullScan: input.forceFullScan,
            rulesetVersion: input.rulesetVersion,
            ...(input.resumed ? { resumed: true } : {}),
            repo: {
              id: repo.githubId,
              full_name: repo.fullName,
              html_url: repo.url,
              description: repo.description,
              stargazers_count: repo.stars,
              forks_count: repo.forks,
              fork: repo.isFork,
              language: repo.language,
              topics: repo.topics,
              created_at: (
                repo.githubCreatedAt || new Date()
              ).toISOString(),
              updated_at: (
                repo.githubUpdatedAt || new Date()
              ).toISOString(),
              pushed_at: (repo.githubPushedAt || new Date()).toISOString(),
              owner: { login: repo.owner },
              name: repo.name,
              default_branch: repo.defaultBranch,
            },
            brands: input.brandRefs,
            internalAudit: input.internalAudit,
          };
        });

      if (jobs.length > 0) {
        await this.scanQueue.enqueueRepositoryAnalysisBulk(
          jobs,
          input.priority,
        );
        enqueued += jobs.length;
      }
    }

    return enqueued;
  }

  async process(job: Job<ScanOrchestratorJobData>): Promise<void> {
    const { workspaceId, scanJobId } = job.data;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );

    const work = async () => {
      const scan = await this.scanState.assertOwned(workspaceId, scanJobId);

      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.finalize(scanJobId);
        return;
      }

      await this.scanState.markRunning(scanJobId);

      if (!(await this.github.isConfiguredForWorkspace(workspaceId))) {
        await this.scanState.markCompletedEarly(
          scanJobId,
          'No GitHub token available (set a shared GITHUB_TOKEN or add one for this workspace in Settings). Scan skipped live GitHub calls.',
        );
        return;
      }

      if (await this.github.isRateLimited(workspaceId)) {
        const until =
          (await this.github.getPausedUntil(workspaceId)) ||
          Date.now() + 60_000;
        await this.github.markScanPause(scanJobId, until);
        await this.scanState.emitRateLimitPause(scanJobId, until);
        const token = (job as Job & { token?: string }).token || '0';
        await job.moveToDelayed(until, token);
        throw new DelayedError(
          `Orchestrator delayed for GitHub quota until ${new Date(until).toISOString()}`,
        );
      }

      await this.github.clearScanPause(scanJobId);

      const mode =
        (job.data.mode as ScanMode) || scan.mode || ScanMode.INCREMENTAL;
      const forceFullScan =
        job.data.forceFullScan === true ||
        scan.forceFullScan === true ||
        mode === ScanMode.FULL;
      const rulesetVersion =
        job.data.rulesetVersion ||
        scan.rulesetVersion ||
        this.incremental.currentRulesetVersion();

      await this.scanModel.findByIdAndUpdate(scanJobId, {
        mode,
        forceFullScan,
        rulesetVersion,
      });

      // Prefer the value resolved (and clamped to the admin ceiling) at
      // enqueue time; fall back to config for pre-existing scans that
      // predate this field.
      const maxRepos =
        scan.maxRepos ||
        Number(
          this.config.get('MAX_REPOSITORIES') ||
            this.config.get('SCAN_MAX_REPOS') ||
            Number.MAX_SAFE_INTEGER,
        );

      const allBrands = await this.brandModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          enabled: true,
        })
        .lean()
        .exec();
      // A brand-scoped scan must stay scoped for matching too, not just for
      // building search queries - otherwise a repo re-analyzed here could
      // still get attributed to an unrelated brand it only fuzzy-matched.
      const scopedForMatching = scan.scopeBrandId
        ? allBrands.filter((b) => String(b._id) === String(scan.scopeBrandId))
        : allBrands;
      const brandRefs = scopedForMatching.map((b) => ({
        id: String(b._id),
        name: b.name,
        aliases: b.aliases,
        trustedGithubOwners: b.trustedGithubOwners,
        keywords: b.keywords,
      }));

      // Resume: failed_only skips search and reprocesses failed github IDs.
      if (mode === ScanMode.FAILED_ONLY) {
        const failedIds =
          await this.incremental.listFailedGithubIds(workspaceId);
        const checkpointIds = scan.checkpoint?.failedGithubIds || [];
        const ids = [...new Set([...failedIds, ...checkpointIds])];
        const enqueued = await this.bulkEnqueueAnalysis({
          workspaceId,
          scanJobId,
          githubIds: ids,
          maxRepos,
          mode,
          rulesetVersion,
          brandRefs,
          forceFullScan: true,
          resumed: true,
          internalAudit: scan.internalAudit === true,
          priority: job.opts.priority || 5,
        });
        await this.scanModel.findByIdAndUpdate(scanJobId, {
          $inc: { awaitingAnalysis: enqueued, reposResumed: enqueued },
          $set: {
            'checkpoint.stage': ScanCheckpointStage.ORCHESTRATED,
            'checkpoint.updatedAt': new Date(),
            message: `Resuming ${enqueued} failed repositories`,
          },
        });
        if (enqueued === 0) {
          await this.scanState.markCompletedEarly(
            scanJobId,
            'No failed repositories to retry',
          );
        }
        return;
      }

      // Resume: analyze_pending skips search entirely and runs real content
      // analysis on every repo a prior discoveryOnly scan found and saved
      // but deliberately deferred (Repository.pendingAnalysis=true) -
      // workspace-wide by default (same as failed_only above, not scoped to
      // any one earlier scan, so it naturally picks up everything
      // accumulated across however many discovery-only runs happened since
      // the last time this was used), or narrowed to one brand and/or a
      // discovered-date window when the caller set scopeBrandId/
      // discoveredFrom/discoveredTo - see IncrementalScanService.
      // buildPendingAnalysisFilter.
      if (mode === ScanMode.ANALYZE_PENDING) {
        const pendingIds = await this.incremental.listPendingAnalysisGithubIds(
          workspaceId,
          {
            brandId: scan.scopeBrandId ? String(scan.scopeBrandId) : undefined,
            discoveredFrom: scan.discoveredFrom,
            discoveredTo: scan.discoveredTo,
          },
        );
        // analyze_pending only ever processes repos a discoveryOnly scan
        // previously found and deferred (Repository.pendingAnalysis=true) -
        // internal audit never leaves repos in that state (it runs full
        // analysis immediately), so everything reaching this branch is
        // guaranteed external. Without this, upsertRepository never writes
        // Repository.origin at all when it's undefined, which would leave a
        // repo whose FIRST-ever write happens to be here (e.g. a pending
        // record from before this field existed) permanently hidden from
        // the Repositories page's origin:'external' filter.
        const enqueued = await this.bulkEnqueueAnalysis({
          workspaceId,
          scanJobId,
          githubIds: pendingIds,
          maxRepos,
          mode,
          rulesetVersion,
          brandRefs,
          forceFullScan: true,
          internalAudit: false,
          priority: job.opts.priority || 5,
        });
        await this.scanModel.findByIdAndUpdate(scanJobId, {
          $inc: {
            awaitingAnalysis: enqueued,
            reposDiscovered: enqueued,
            reposFound: enqueued,
            reposTotal: enqueued,
          },
          $set: {
            'checkpoint.stage': ScanCheckpointStage.ORCHESTRATED,
            'checkpoint.updatedAt': new Date(),
            message: `Analyzing ${enqueued} previously discovered repositories`,
          },
        });
        if (enqueued === 0) {
          await this.scanState.markCompletedEarly(
            scanJobId,
            'No pending discovered repositories to analyze',
          );
        }
        return;
      }

      // Internal audit: no search at all - exhaustively enumerate every
      // repo under the scoped brand's own trustedGithubOwners accounts and
      // send them straight to analysis. Fundamentally different from every
      // other mode above, which all discover repos by searching GitHub for
      // MENTIONS of the brand.
      if (scan.internalAudit) {
        const scopedBrand = brandRefs[0];
        const owners = scopedBrand?.trustedGithubOwners || [];
        if (!scopedBrand || owners.length === 0) {
          await this.scanState.markCompletedEarly(
            scanJobId,
            'Scoped brand has no trustedGithubOwners configured',
          );
          return;
        }

        // Same createdFrom/createdTo/pushedFrom/pushedTo/dateFilterMode the
        // external search path turns into a GitHub `created:`/`pushed:`
        // qualifier - here there's no search query to attach one to (this
        // enumerates trustedGithubOwners repos directly via REST), so it's
        // applied as an in-process filter over each owner's repo list
        // instead. Lets an internal audit be scoped to "only repos created
        // or changed today" instead of unconditionally re-auditing every
        // repo the brand owns on every run.
        const activityWindow = {
          createdFrom: scan.createdFrom,
          createdTo: scan.createdTo,
          pushedFrom: scan.pushedFrom,
          pushedTo: scan.pushedTo,
          dateFilterMode: scan.dateFilterMode,
        };

        let enqueued = 0;
        const ownerErrors: string[] = [];
        ownerLoop: for (const owner of owners) {
          if (await this.scanState.isCancelled(scanJobId)) {
            await this.scanState.finalize(scanJobId);
            return;
          }
          let repos;
          try {
            repos = await this.github.listAllOwnerRepos(owner, {
              workspaceId,
              scanJobId,
            });
            repos = repos.filter((item) =>
              repoMatchesActivityWindow(item, activityWindow),
            );
          } catch (error) {
            const reason = safeJobError(error);
            this.logger.warn(
              `Internal audit: could not list repos for ${owner}: ${reason}`,
            );
            ownerErrors.push(`${owner}: ${reason}`);
            continue;
          }
          for (const item of repos) {
            if (enqueued >= maxRepos) break ownerLoop;
            if (await this.scanState.isCancelled(scanJobId)) {
              await this.scanState.finalize(scanJobId);
              return;
            }
            const claimed = await this.incremental.claimRepositoryForAnalysis(
              scanJobId,
              item.id,
              maxRepos,
            );
            if (!claimed) continue;
            await this.scanQueue.enqueueRepositoryAnalysis(
              {
                workspaceId,
                scanJobId,
                mode,
                forceFullScan,
                rulesetVersion,
                repo: {
                  id: item.id,
                  full_name: item.full_name,
                  html_url: item.html_url,
                  description: item.description,
                  stargazers_count: item.stargazers_count,
                  forks_count: item.forks_count,
                  fork: item.fork,
                  language: item.language,
                  topics: item.topics,
                  created_at: item.created_at,
                  updated_at: item.updated_at,
                  pushed_at: item.pushed_at,
                  owner: item.owner,
                  name: item.name,
                  default_branch: item.default_branch,
                  size: item.size,
                },
                brands: [scopedBrand],
                internalAudit: true,
              },
              job.opts.priority || 5,
            );
            enqueued += 1;
          }
        }

        await this.scanModel.findByIdAndUpdate(scanJobId, {
          $inc: {
            awaitingAnalysis: enqueued,
            reposDiscovered: enqueued,
            reposFound: enqueued,
            reposTotal: enqueued,
          },
          $set: {
            'checkpoint.stage': ScanCheckpointStage.ORCHESTRATED,
            'checkpoint.updatedAt': new Date(),
            message: `Internal audit: enumerated ${enqueued} repo${enqueued === 1 ? '' : 's'} across ${owners.length} trusted account${owners.length === 1 ? '' : 's'}`,
          },
        });
        if (enqueued === 0) {
          const hasActivityWindow = Boolean(
            activityWindow.createdFrom ||
              activityWindow.createdTo ||
              activityWindow.pushedFrom ||
              activityWindow.pushedTo,
          );
          const message =
            ownerErrors.length > 0
              ? `No repos found under this brand's trusted GitHub accounts - ${ownerErrors.length} of ${owners.length} owner(s) errored: ${ownerErrors.join('; ')}`
              : hasActivityWindow
                ? "No repos under this brand's trusted GitHub accounts were created or pushed within the selected date range"
                : "No repos found under this brand's trusted GitHub accounts";
          await this.scanState.markCompletedEarly(scanJobId, message);
        }
        return;
      }

      const brands = allBrands;
      const keywords = await this.keywordModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          enabled: true,
        })
        .lean()
        .exec();
      const createdFrom = scan.createdFrom
        ? new Date(scan.createdFrom).toISOString().slice(0, 10)
        : undefined;
      const createdTo = scan.createdTo
        ? new Date(scan.createdTo).toISOString().slice(0, 10)
        : undefined;
      const pushedFrom = scan.pushedFrom
        ? new Date(scan.pushedFrom).toISOString().slice(0, 10)
        : undefined;
      const pushedTo = scan.pushedTo
        ? new Date(scan.pushedTo).toISOString().slice(0, 10)
        : undefined;

      let querySpecs: SearchQuerySpec[];
      if (
        scan.scopeKeyword &&
        !scan.scopeQuery &&
        (scan.customRepoQuery || scan.customCodeQuery)
      ) {
        // User edited the auto-generated query for this keyword in the UI -
        // use those strings exactly as given instead of calling
        // buildQueryFamilies at all. Deliberately skips the 'or'-mode
        // two-query date-qualifier split buildSearchQueries would otherwise
        // do: the user is now in direct control of the query text, and any
        // date qualifier they want is expected to already be baked into
        // customRepoQuery itself (that's what the preview endpoint hands
        // back pre-filled with).
        querySpecs = [];
        if (scan.customRepoQuery) {
          querySpecs.push({
            kind: 'repositories',
            family: 'brand-keyword-custom',
            query: scan.customRepoQuery,
          });
        }
        if (scan.customCodeQuery) {
          querySpecs.push({
            kind: 'code',
            family: 'brand-keyword-custom-code',
            query: scan.customCodeQuery,
          });
        }
      } else if (scan.scopeQuery) {
        const scopeKind = scan.scopeSearchKind || 'repositories';
        // 'or' mode with both a created and a pushed qualifier yields two
        // independent qualifier strings here - each becomes its own query
        // spec below, since GitHub has no OR between two different
        // qualifier types in one query string.
        const dateQualifierVariants =
          scopeKind === 'repositories'
            ? buildDateQualifierVariants(
                createdFrom,
                createdTo,
                pushedFrom,
                pushedTo,
                scan.dateFilterMode,
              )
            : [];
        const scopeQuery = scan.scopeQuery;
        const qualifiersOrNone: Array<string | undefined> =
          dateQualifierVariants.length > 0 ? dateQualifierVariants : [undefined];
        querySpecs = qualifiersOrNone.map((qualifier) => ({
          kind: scopeKind,
          family: 'custom',
          query: qualifier ? `${scopeQuery} ${qualifier}` : scopeQuery,
        }));
      } else {
        const scopedBrands = scan.scopeBrandId
          ? brands.filter((b) => String(b._id) === String(scan.scopeBrandId))
          : brands;
        const phrasesByBrand = await this.fetchDistinctivePhrasesByBrand(
          workspaceId,
          scopedBrands.map((b) => b._id),
        );
        const scopedBrandsWithPhrases = scopedBrands.map((b) => ({
          ...b,
          distinctivePhrases: phrasesByBrand.get(String(b._id)) || [],
        }));
        querySpecs = this.pipeline.buildSearchQueries(
          scopedBrandsWithPhrases,
          keywords,
          {
            createdFrom,
            createdTo,
            pushedFrom,
            pushedTo,
            dateFilterMode: scan.dateFilterMode,
          },
          Boolean(scan.scopeBrandId),
          scan.scopeKeyword,
          scan.searchScope,
        );
      }
      const queries = querySpecs.map(
        (q) => `[${q.kind}/${q.family}] ${q.query}`,
      );
      await this.scanState.setQueries(scanJobId, queries);
      await this.incremental.saveCheckpoint(scanJobId, {
        stage: ScanCheckpointStage.ORCHESTRATED,
      });

      if (querySpecs.length === 0) {
        await this.scanState.markCompletedEarly(
          scanJobId,
          scan.scopeBrandId
            ? 'Scoped brand is disabled or was not found'
            : 'No enabled brands to search',
        );
        return;
      }

      const cursors = scan.checkpoint?.searchCursors || {};
      // Recorded once here, before any search job runs, so the scan detail
      // page can show a real, checkable answer to "did this actually resume
      // from last time" instead of asking the user to just trust it - see
      // ScanJob.checkpoint.searchStartPages.
      const searchStartPages: Record<string, number> = {
        ...(scan.checkpoint?.searchStartPages || {}),
      };
      for (let i = 0; i < querySpecs.length; i += 1) {
        if (await this.scanState.isCancelled(scanJobId)) {
          await this.scanState.finalize(scanJobId);
          return;
        }
        const spec = querySpecs[i];
        // This scan's own in-progress checkpoint (set if the orchestrator
        // job is being retried after a crash) always wins - it's resuming
        // THIS scan's own work, not starting a new one. Only when that's
        // empty (a genuinely new scan) does continueDiscovery decide
        // whether to pick up this workspace's durable per-query cursor from
        // a PRIOR scan, or start fresh at page 1 like before.
        const inScanCursor = cursors[String(i)];
        const resumePage = inScanCursor
          ? Number(inScanCursor) + 1
          : scan.continueDiscovery
            ? await this.discoveryCursor.getResumePage(
                workspaceId,
                spec.kind,
                spec.query,
              )
            : 1;
        searchStartPages[String(i)] = resumePage;
        await this.scanQueue.enqueueGithubSearch(
          {
            workspaceId,
            scanJobId,
            query: spec.query,
            queryIndex: i,
            maxRepos,
            mode,
            forceFullScan,
            rulesetVersion,
            page: resumePage,
            searchKind: spec.kind,
            family: spec.family,
            discoveryOnly: scan.discoveryOnly === true,
          },
          job.opts.priority || 5,
        );
      }
      await this.incremental.saveCheckpoint(scanJobId, { searchStartPages });
    };

    try {
      await withJobTimeout(
        work(),
        timeoutMs,
        `Orchestrator timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      if (
        error instanceof DelayedError ||
        (error as Error)?.name === 'DelayedError'
      ) {
        throw error;
      }
      this.logger.error(
        `Orchestrator failed for ${scanJobId}: ${safeJobError(error)}`,
      );
      await this.scanState.markFailed(scanJobId, error);
      if (isGitHubClientError(error) && error.code === 'AUTH') {
        return;
      }
      try {
        await delayJobForGitHubQuota(job, error, this.github, this.scanState);
      } catch (delayed) {
        if (
          delayed instanceof DelayedError ||
          (delayed as Error)?.name === 'DelayedError'
        ) {
          throw delayed;
        }
      }
      throw error;
    }
  }
}
