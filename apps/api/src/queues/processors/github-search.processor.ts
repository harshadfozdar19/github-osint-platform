import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import { QUEUE_GITHUB_SEARCH, GitHubSearchJobData } from '../queue.constants';
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
import { ScanJob, ScanJobDocument } from '../../scans/schemas/scan-job.schema';
import {
  safeJobError,
  isFinalAttempt,
  withJobTimeout,
  sharedWorkerTuning,
  watchForCancellation,
} from '../queue.utils';
import { delayJobForGitHubQuota } from '../github-job.utils';
import { ScanCheckpointStage, ScanMode } from '../../common/enums';
import { hasWordBoundaryMatch } from '../../common/utils/word-match.util';
import {
  buildLanguageSplitQueries,
  ensureBoundedCreatedRange,
  ensureBoundedSizeRange,
  repoMatchesActivityWindow,
  splitCreatedRangeQuery,
  splitSizeRangeQuery,
} from '../../scans/discovery/query-families';

@Processor(QUEUE_GITHUB_SEARCH, {
  // Raised from 2 now that GitHubHttpClient paces search/code_search
  // requests itself (Redis-coordinated minimum interval per token+resource,
  // shared across every concurrent caller) - the worker pool no longer
  // needs to be small to protect the rate limit, that job now belongs to
  // paceRequest. A bigger pool matters more now that several keyword-scoped
  // scans can run concurrently for the same brand: with too few slots, a
  // repo-search job and a code-search job (independent budgets, independent
  // pacing) would needlessly queue behind each other instead of both
  // making progress at once.
  concurrency: Number(process.env.WORKER_CONCURRENCY_GITHUB_SEARCH || 8),
  lockDuration: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 120_000),
  ...sharedWorkerTuning(),
})
export class GitHubSearchProcessor extends WorkerHost {
  private readonly logger = new Logger(GitHubSearchProcessor.name);

  // "Near enough to the 1000 cap to be worth splitting" - proactive, not
  // reactive: acts before a query actually starts losing results, not after.
  private static readonly CODE_SEARCH_SPLIT_THRESHOLD = 950;
  private static readonly DATE_RANGE_SPLIT_THRESHOLD = 950;
  // Keeps synthetic split-query indices guaranteed clear of the real
  // 0..maxQueries-1 range the orchestrator assigns to its own querySpecs,
  // so a split query's checkpoint entry can never collide with (and
  // silently corrupt) a real query's searchCursors/searchStartPages entry.
  // Separate base ranges keep the two split mechanisms' synthetic indices
  // disjoint from each other too.
  private static readonly SPLIT_QUERY_INDEX_BASE = 100_000;
  private static readonly DATE_SPLIT_QUERY_INDEX_BASE = 200_000;
  private static readonly DATE_SPLIT_QUERY_INDEX_RANGE = 800_000;
  // Starts exactly where the date-split range ends (200_000 + 800_000) -
  // reuses syntheticQueryIndex's same DATE_SPLIT_QUERY_INDEX_RANGE-wide
  // hash modulus, just offset into its own disjoint block.
  private static readonly SIZE_SPLIT_QUERY_INDEX_BASE = 1_000_000;

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
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
  ) {
    super();
  }

  async process(job: Job<GitHubSearchJobData>): Promise<void> {
    const { workspaceId, scanJobId, query, maxRepos } = job.data;
    const page = job.data.page || 1;
    const timeoutMs = Number(
      this.config.get('QUEUE_JOB_TIMEOUT_MS') || 120_000,
    );
    const abort = new AbortController();
    // A search request can end up sleeping through a multi-minute
    // GitHub-imposed rate-limit wait (see GitHubHttpClient.delayOrThrow) -
    // without this, cancelling the scan mid-wait wouldn't free this worker
    // slot until the wait ran out on its own.
    const stopWatchingCancellation = watchForCancellation(
      this.scanState,
      scanJobId,
      abort,
    );

    try {
      await this.scanState.assertOwned(workspaceId, scanJobId);
      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.completeSearchJob(scanJobId, 0);
        return;
      }

      const work = async () => {
        const scan = await this.scanModel.findById(scanJobId).lean().exec();

        // Bail out early if the scan is already in a terminal state or at cap.
        const terminalStatuses = [
          'completed',
          'partially_completed',
          'failed',
          'cancelled',
        ];
        if (scan && terminalStatuses.includes(scan.status)) {
          // debug, not log - see the matching comment in
          // RepositoryAnalysisProcessor. A cancelled/finalized scan can
          // still have a backlog of already-queued search jobs (including
          // ones a split/bisect fanned out just before cancellation); each
          // draining out this way is expected, not worth a 'log'-level line.
          this.logger.debug(
            `Search skipped: scan ${scanJobId} already ${scan.status}`,
          );
          return;
        }
        const already = scan?.reposDiscovered || 0;
        if (already >= maxRepos) {
          await this.scanState.completeSearchJob(scanJobId, 0);
          return;
        }

        const mode =
          (job.data.mode as ScanMode) ||
          (scan?.mode as ScanMode) ||
          ScanMode.INCREMENTAL;
        const forceFullScan =
          job.data.forceFullScan === true || scan?.forceFullScan === true;
        const rulesetVersion =
          job.data.rulesetVersion ||
          scan?.rulesetVersion ||
          this.incremental.currentRulesetVersion();

        const batchSize = Number(this.config.get('SEARCH_BATCH_SIZE') || 100);
        const searchKind = job.data.searchKind || 'repositories';

        // GitHub's Search API hard-caps every query at 1000 results total
        // (page * per_page > 1000 gets rejected with a 422, regardless of
        // how large total_count claims to be) - nothing back there is ever
        // fetchable. A durable continueDiscovery cursor could reach exactly
        // this ceiling on a popular query; without this check, the next
        // scan would request the next page anyway and 422 forever instead
        // of correctly restarting at page 1. Caught live: total_count > cap
        // kept hasMoreResults true right up to the boundary.
        const GITHUB_SEARCH_MAX_RESULTS = 1000;
        if ((page - 1) * batchSize >= GITHUB_SEARCH_MAX_RESULTS) {
          await this.discoveryCursor.saveCursor(
            workspaceId,
            searchKind,
            query,
            page,
            true,
          );
          await this.scanState.completeSearchJob(scanJobId, 0);
          return;
        }

        const result =
          searchKind === 'code'
            ? await this.github.searchCode(query, page, batchSize, {
                workspaceId,
                scanJobId,
                signal: abort.signal,
              })
            : await this.github.searchRepositories(query, page, batchSize, {
                workspaceId,
                scanJobId,
                signal: abort.signal,
              });
        await this.github.clearScanPause(scanJobId);
        // Either split hands this exact query's remaining coverage off to
        // narrower children - if one fires, this original query must NOT
        // also keep paging itself via the normal continuation below, or
        // its own pages 2-10 would redundantly re-cover the same ground
        // the split children now own (wasted requests, not a correctness
        // bug, since per-scan dedup still prevents double-analyzing a
        // repo - but avoidable, and compounds each time a date-split
        // recurses into further splits).
        //
        // continueDiscovery is threaded into every split below so a child
        // query that already has its own durable DiscoveryCursor progress
        // (e.g. lastPage: 9 from an earlier turn) resumes from there
        // instead of restarting at page 1 - see resumePageFor's doc
        // comment for why this matters: a popular single-word keyword
        // search almost always exceeds the split threshold, so nearly ALL
        // of its real pagination progress lives in split children, not the
        // parent query.
        const continueDiscovery = Boolean(scan?.continueDiscovery);
        const splitHandledCoverage =
          (await this.maybeSplitOversizedCodeQuery(
            job,
            result.total_count,
            continueDiscovery,
          )) ||
          (await this.maybeSplitOversizedCodeSizeRange(
            job,
            result.total_count,
            continueDiscovery,
          )) ||
          (await this.maybeSplitOversizedDateRangeQuery(
            job,
            result.total_count,
            continueDiscovery,
          ));

        const allEnabledBrands = await this.brandModel
          .find({
            workspaceId: new Types.ObjectId(workspaceId),
            enabled: true,
          })
          .lean()
          .exec();
        // A scan scoped to one brand must stay scoped all the way through -
        // otherwise a repo found while searching for "Angel One" could still
        // get attributed to some other monitored brand (e.g. "Groww") purely
        // because it happened to fuzzy-match that brand's alias too, which
        // is confusing when the whole point of scoping was "only tell me
        // about this one brand".
        const brands = scan?.scopeBrandId
          ? allEnabledBrands.filter(
              (b) => String(b._id) === String(scan.scopeBrandId),
            )
          : allEnabledBrands;

        // GitHub's Code Search API has no created:/pushed: qualifier to bake
        // a date filter into the query string itself (unlike repository
        // search, which already gets one via buildDateQualifierVariants at
        // orchestration time - see query-families.ts). Applied here instead,
        // against the created_at/pushed_at GitHub already returned in this
        // same search response - no extra GitHub request, no commit lookup.
        // Repository-search results are left alone since their query string
        // already enforces this; re-checking them here would be redundant.
        const activityWindow = {
          createdFrom: scan?.createdFrom,
          createdTo: scan?.createdTo,
          pushedFrom: scan?.pushedFrom,
          pushedTo: scan?.pushedTo,
          dateFilterMode: scan?.dateFilterMode,
        };
        let droppedForActivityWindow = 0;

        let enqueued = 0;
        for (const item of result.items) {
          if (await this.scanState.isCancelled(scanJobId)) break;

          // Must come before claimRepositoryForAnalysis - a repo outside the
          // scan's date window should never be claimed, deduped, or
          // enqueued; it should behave exactly like it never matched.
          if (
            searchKind === 'code' &&
            !repoMatchesActivityWindow(item, activityWindow)
          ) {
            droppedForActivityWindow += 1;
            continue;
          }

          if (job.data.discoveryOnly) {
            // Cross-scan dedup: if ANY scan already recorded this repo -
            // this one on an earlier page, or a DIFFERENT concurrently
            // running scan (e.g. another keyword's toggle for the same
            // brand) - it's not a new discovery. Checked against the
            // durable Repository collection, not just this scan's own
            // checkpoint, specifically so several keyword-scoped discovery
            // scans for the same brand can run at once without each one
            // re-claiming/re-counting/re-upserting repos the others already
            // found - "already found" should mean workspace-wide, not just
            // within one scan.
            const alreadyKnown = await this.incremental.findByGithubId(
              workspaceId,
              item.id,
            );
            if (alreadyKnown) {
              // Still worth recording: this scan's own brand may be
              // genuinely relevant to this repo too (a broker-comparison
              // app mentioning several brands by name, say), even though
              // some OTHER brand's scan found it first - see
              // recordAdditionalBrandMatch's doc comment for why this
              // would otherwise silently vanish for every brand except
              // whichever one happened to discover it first.
              if (scan?.scopeBrandId) {
                const evidence = this.resolveDiscoveryMatchEvidence(
                  item,
                  searchKind,
                  scan?.scopeKeyword,
                );
                await this.incremental.recordAdditionalBrandMatch(
                  workspaceId,
                  item.id,
                  {
                    brandId: String(scan.scopeBrandId),
                    keyword: scan?.scopeKeyword,
                    matchedField: evidence.field,
                    matchedPath: evidence.path,
                    matchedText: evidence.text,
                  },
                );
              }
              continue;
            }
          }

          const claimed = await this.incremental.claimRepositoryForAnalysis(
            scanJobId,
            item.id,
            maxRepos,
          );
          if (!claimed) continue;

          // Discovery-only: record the repo (metadata already in hand from
          // this search response - no extra GitHub call) and stop right
          // here. No clone, no file fetch, no detection, no finding - it's
          // saved as a candidate (Repository.pendingAnalysis=true) for a
          // later ANALYZE_PENDING run to pick up, not sent to analysis now.
          if (job.data.discoveryOnly) {
            const evidence = this.resolveDiscoveryMatchEvidence(
              item,
              searchKind,
              scan?.scopeKeyword,
            );
            await this.pipeline.upsertRepository(workspaceId, item, {
              scanJobId,
              discoveredOnly: true,
              discoveryMatchedField: evidence.field,
              discoveryMatchedPath: evidence.path,
              discoveryMatchedText: evidence.text,
              discoveryBrandId: scan?.scopeBrandId
                ? String(scan.scopeBrandId)
                : undefined,
              discoveryKeyword: scan?.scopeKeyword,
              // This path only ever runs for external keyword/GitHub-search
              // discovery - internal audit enumerates trustedGithubOwners
              // directly via REST and never reaches the search processor.
              internalAudit: false,
            });
            await this.scanState.recordRepositoryDiscovered(scanJobId, {
              countsTowardAnalysis: false,
            });
            enqueued += 1;
            continue;
          }

          // Must land before enqueueing this repo's analysis job, not after
          // the whole page's loop - otherwise a fast "skip" decision from a
          // concurrent analysis worker can complete before this repo's own
          // discovery credit is recorded, showing reposProcessed transiently
          // exceeding reposDiscovered on the scan detail page.
          await this.scanState.recordRepositoryDiscovered(scanJobId);

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
                owner: { login: item.owner.login },
                name: item.name,
                default_branch: item.default_branch,
                size: item.size,
              },
              brands: brands.map((b) => ({
                id: String(b._id),
                name: b.name,
                aliases: b.aliases,
                trustedGithubOwners: b.trustedGithubOwners,
                keywords: b.keywords,
              })),
              // This processor only ever runs for external keyword/GitHub-
              // search discovery - internal audit enumerates
              // trustedGithubOwners directly via REST and never reaches it
              // (see the discoveryOnly branch above's own comment). Without
              // this, RepositoryAnalysisProcessor's upsertRepository calls
              // receive internalAudit=undefined and silently never write
              // Repository.origin at all (upsertRepository only sets it
              // when the caller's internalAudit is explicitly defined) -
              // permanently hiding the repo from the Repositories page,
              // which filters on origin:'external' exactly.
              internalAudit: false,
            },
            job.opts.priority || 5,
          );
          enqueued += 1;
        }

        if (droppedForActivityWindow > 0) {
          this.logger.log(
            `Query "${query}" (code search): dropped ${droppedForActivityWindow} repo(s) outside the scan's date window for scan ${scanJobId}`,
          );
        }

        await this.incremental.saveCheckpoint(scanJobId, {
          stage: ScanCheckpointStage.SEARCH,
          searchCursors: {
            ...(scan?.checkpoint?.searchCursors || {}),
            [String(job.data.queryIndex)]: page,
          },
        });

        // Determine if there are more pages and we haven't hit the limit yet
        // - total_count alone isn't trustworthy near GitHub's 1000-result
        // ceiling (see GITHUB_SEARCH_MAX_RESULTS above): it can report a
        // count far larger than what's actually fetchable, which would
        // otherwise keep this true forever right at the boundary. A query
        // that just got split is also never "more results to page through"
        // for itself - its remaining coverage now belongs to its children.
        const hasMoreResults =
          !splitHandledCoverage &&
          result.items.length === batchSize &&
          result.total_count > page * batchSize &&
          page * batchSize < GITHUB_SEARCH_MAX_RESULTS;
        const currentReposDiscovered = (scan?.reposDiscovered || 0) + enqueued;

        // Durable, cross-scan bookmark for this exact query - written
        // unconditionally (regardless of whether THIS scan opted into
        // continueDiscovery) so a workspace's discovery history is captured
        // either way, ready for whenever a future scan does opt in. Whether
        // GitHub itself has more pages left (hasMoreResults) is independent
        // of maxRepos capping this scan's own budget - a query capped by
        // maxRepos while GitHub still has more results must NOT be marked
        // exhausted, or a future continuation would wrongly restart at 1.
        await this.discoveryCursor.saveCursor(
          workspaceId,
          searchKind,
          query,
          page,
          !hasMoreResults,
        );

        if (hasMoreResults && currentReposDiscovered < maxRepos) {
          await this.scanModel.findByIdAndUpdate(scanJobId, {
            $inc: { awaitingSearch: 1 },
          });
          await this.scanQueue.enqueueGithubSearch(
            {
              workspaceId,
              scanJobId,
              query,
              queryIndex: job.data.queryIndex,
              maxRepos,
              mode,
              forceFullScan,
              rulesetVersion,
              page: page + 1,
              searchKind: job.data.searchKind,
              family: job.data.family,
              // Was missing here - page 2+ of any query silently lost the
              // discoveryOnly flag (defaulting to falsy/undefined), so any
              // keyword whose results spanned more than one page quietly
              // dropped out of "discover only" and started running full
              // content analysis (clone, fetch package.json/README, etc.)
              // on every repo from page 2 onward - exactly the unwanted
              // automatic GitHub traffic this flag exists to prevent.
              discoveryOnly: job.data.discoveryOnly,
            },
            job.opts.priority || 5,
          );
        }

        await this.scanState.completeSearchJob(scanJobId, enqueued);
      };

      await withJobTimeout(
        work(),
        timeoutMs,
        `GitHub search timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      abort.abort();
      if (
        error instanceof DelayedError ||
        (error as Error)?.name === 'DelayedError'
      ) {
        throw error;
      }
      // The cancellation watcher above is what aborted us (mid-wait or
      // mid-request) - a clean, intentional stop, not a failure worth
      // logging or retrying like a real GitHub error would be.
      if (await this.scanState.isCancelled(scanJobId)) {
        await this.scanState.completeSearchJob(scanJobId, 0);
        return;
      }
      // Rate/pacing errors (RATE_LIMIT, SECONDARY_RATE_LIMIT, BUDGET) are
      // expected under concurrent load and self-heal via delayJobForGitHubQuota
      // below (the job is rescheduled, not failed) - logging these at 'warn'
      // reads as a real failure and worries users watching the logs for
      // nothing. Anything else genuinely is worth a warn.
      const isPacingError =
        isGitHubClientError(error) &&
        (error.code === 'RATE_LIMIT' ||
          error.code === 'SECONDARY_RATE_LIMIT' ||
          error.code === 'BUDGET');
      if (isPacingError) {
        this.logger.log(
          `GitHub search for scan ${scanJobId} rescheduled (GitHub quota pacing): ${safeJobError(error)}`,
        );
      } else {
        this.logger.warn(
          `GitHub search failed for scan ${scanJobId}: ${safeJobError(error)}`,
        );
      }

      // 401 AUTH error: token invalid/expired — fail fast without retrying
      if (isGitHubClientError(error) && error.code === 'AUTH') {
        await this.scanModel.findByIdAndUpdate(scanJobId, {
          message: 'GitHub authentication failed — check GITHUB_TOKEN',
          error: 'GitHub authentication failed (401 Unauthorized)',
        });
        await this.scanState.completeSearchJob(scanJobId, 0);
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
      if (isFinalAttempt(job)) {
        await this.scanState.completeSearchJob(scanJobId, 0);
      }
      throw error;
    } finally {
      stopWatchingCancellation();
    }
  }

  /**
   * ANY code-search query can silently lose results past GitHub's
   * 1000-per-query cap - not just the brand-agnostic secret-filename
   * sweeps this originally only covered. A brand-scoped code query
   * (`brand-secret`, `brand-keyword-custom-code`, `distinctive-content`)
   * can just as easily land on a common enough term to cross 1000 hits, and
   * there was previously no relief for those at all - they'd just hard-cap
   * at page 10 and restart at page 1 every future scan. Adaptive, one-level
   * split: only once this query's own first page reveals it's genuinely
   * near that ceiling, fan out into per-language variants. Each is a
   * distinct query string, so DiscoveryCursorService (keyed by exact query
   * text) automatically gives every one its own independent budget and
   * resume cursor - no new cursor plumbing needed, same mechanism that
   * already makes date-slicing work for repository search. Gated to page 1
   * (decide once per query) and to family names that don't already end in
   * `-split`, so a split query's own results are never split again.
   */
  /**
   * Best-effort discovery-time match evidence - which repo field (or, for a
   * code-search hit, which file) actually contains the scan's own keyword.
   * Cheap: uses metadata already in hand from the search response (or, for
   * code search, GitHub's own per-file `path` - see
   * GitHubService.searchCode's matchedPath), so it costs no extra GitHub
   * request. A repo-search hit only checks metadata against `keyword`
   * because that's the one literal term this scan is actually scoped to; a
   * full brand sweep (no keyword) has no single term to check against and
   * gets nothing here, same as before this existed - it still gets real
   * evidence once content-analyzed and a Finding exists.
   */
  private resolveDiscoveryMatchEvidence(
    item: {
      name: string;
      description: string | null;
      topics?: string[];
      matchedPath?: string;
    },
    searchKind: 'repositories' | 'code',
    keyword?: string,
  ): { field?: string; path?: string; text?: string } {
    if (searchKind === 'code') {
      return item.matchedPath
        ? { field: 'file_content', path: item.matchedPath }
        : {};
    }
    if (!keyword) return {};
    // Word-boundary-aware, not a bare substring check - otherwise a search
    // for "fyers" would credit a repo whose name/description only happens
    // to contain "identifyers"/"modifyers" with no relation to the brand.
    // See word-match.util.ts for exactly what counts as a boundary
    // (camelCase/snake_case/path-separated compounds still count).
    const needle = keyword.toLowerCase();
    if (item.name && hasWordBoundaryMatch(item.name, needle)) {
      return { field: 'repo_name', text: item.name };
    }
    if (item.description && hasWordBoundaryMatch(item.description, needle)) {
      return { field: 'description', text: item.description };
    }
    const topicsText = (item.topics || []).join(', ');
    if (hasWordBoundaryMatch(topicsText, needle)) {
      return { field: 'topics', text: topicsText };
    }
    return {};
  }

  /**
   * A split child's own starting page - resumes from its own durable
   * DiscoveryCursor when the scan wants to continue discovery, same as
   * the top-level per-scan dispatch in ScanOrchestratorProcessor does for
   * an UNSPLIT query. Without this, every split child was hardcoded to
   * page 1 regardless of continueDiscovery - and since a query only gets
   * split at all because it's too big for one page-1 check (near/over the
   * 900-result threshold), essentially every query worth resuming is
   * exactly the kind that gets split, making "Resume from last" a no-op
   * in practice for real, popular keywords: the parent query's own cursor
   * gets marked exhausted the instant it's split, so on the NEXT turn it
   * restarts at page 1, re-splits into the SAME (now-stable, since the
   * date-split boundary no longer drifts day to day) child query strings,
   * and those children - previously always page 1 - clobbered whatever
   * real progress (lastPage: 9, say) their own cursor already had, via
   * saveCursor's unconditional overwrite.
   */
  private async resumePageFor(
    workspaceId: string,
    searchKind: 'repositories' | 'code',
    query: string,
    continueDiscovery: boolean,
  ): Promise<number> {
    if (!continueDiscovery) return 1;
    return this.discoveryCursor.getResumePage(workspaceId, searchKind, query);
  }

  private async maybeSplitOversizedCodeQuery(
    job: Job<GitHubSearchJobData>,
    totalCount: number,
    continueDiscovery: boolean,
  ): Promise<boolean> {
    const {
      workspaceId,
      scanJobId,
      query,
      maxRepos,
      mode,
      forceFullScan,
      rulesetVersion,
    } = job.data;
    if (
      job.data.searchKind !== 'code' ||
      (job.data.page || 1) !== 1 ||
      job.data.family?.endsWith('-split') ||
      totalCount < GitHubSearchProcessor.CODE_SEARCH_SPLIT_THRESHOLD
    ) {
      return false;
    }

    // Multiplied by splitQueries.length, NOT the fixed
    // CODE_SEARCH_SPLIT_LANGUAGES.length - buildLanguageSplitQueries
    // returns one more query than there are languages (the trailing
    // "everything not in any of those languages" catch-all), and this
    // multiplier defines each original queryIndex's reserved slot width -
    // using the wrong (smaller) constant here would let slot N's last
    // child collide with slot N+1's first child.
    const splitQueries = buildLanguageSplitQueries(query);
    for (let i = 0; i < splitQueries.length; i += 1) {
      await this.scanQueue.enqueueGithubSearch(
        {
          workspaceId,
          scanJobId,
          query: splitQueries[i],
          queryIndex:
            GitHubSearchProcessor.SPLIT_QUERY_INDEX_BASE +
            job.data.queryIndex * splitQueries.length +
            i,
          maxRepos,
          mode,
          forceFullScan,
          rulesetVersion,
          page: await this.resumePageFor(
            workspaceId,
            'code',
            splitQueries[i],
            continueDiscovery,
          ),
          searchKind: 'code',
          family: `${job.data.family}-split`,
          discoveryOnly: job.data.discoveryOnly,
        },
        job.opts.priority || 5,
      );
    }
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $inc: { awaitingSearch: splitQueries.length },
    });
    this.logger.log(
      `Query "${query}" hit ${totalCount} total results (near the 1000 cap) - split into ${splitQueries.length} language-scoped queries (including the unclassified/"Other" catch-all) for scan ${scanJobId}`,
    );
    return true;
  }

  // Code search's rate-limit quota (10/min) is a third of repository
  // search's (30/min - see MAX_DATE_SPLIT_DEPTH's comment), so worst-case
  // fan-out costs 3x longer per request here. 7, not 10: 2^7 = 128 leaf
  // queries covers ~115,000 results in the typical (evenly-spread) case -
  // comfortably past "50k, maybe even 100k" - while keeping the genuine
  // worst case (every branch needs to split all the way down) at 128
  // requests / 10 per minute ≈ 13 minutes, not the unbounded blowup the cap
  // exists to prevent.
  private static readonly MAX_SIZE_SPLIT_DEPTH = 7;

  /**
   * Second overflow-relief dimension for CODE search - see
   * splitSizeRangeQuery. Only ever applies to an already language-split
   * child (family ending `-split`): the ORIGINAL query always tries
   * language splitting first (maybeSplitOversizedCodeQuery above), since
   * that's "free" in the sense of not needing any query-text surgery
   * beyond appending `language:X`. This picks up from there for whichever
   * language buckets are STILL over the cap (a hugely disproportionate
   * language, or a brand-agnostic sweep with no language signal at all),
   * recursing by file size the same way maybeSplitOversizedDateRangeQuery
   * recurses by date for repository search.
   */
  private async maybeSplitOversizedCodeSizeRange(
    job: Job<GitHubSearchJobData>,
    totalCount: number,
    continueDiscovery: boolean,
  ): Promise<boolean> {
    const {
      workspaceId,
      scanJobId,
      query,
      maxRepos,
      mode,
      forceFullScan,
      rulesetVersion,
      family,
    } = job.data;
    const depth = job.data.sizeSplitDepth || 0;
    if (
      job.data.searchKind !== 'code' ||
      (job.data.page || 1) !== 1 ||
      !family?.endsWith('-split') ||
      depth >= GitHubSearchProcessor.MAX_SIZE_SPLIT_DEPTH ||
      totalCount < GitHubSearchProcessor.CODE_SEARCH_SPLIT_THRESHOLD
    ) {
      return false;
    }

    const halves = splitSizeRangeQuery(ensureBoundedSizeRange(query));
    if (!halves) return false;

    for (const half of halves) {
      await this.scanQueue.enqueueGithubSearch(
        {
          workspaceId,
          scanJobId,
          query: half,
          queryIndex: GitHubSearchProcessor.syntheticQueryIndex(
            GitHubSearchProcessor.SIZE_SPLIT_QUERY_INDEX_BASE,
            half,
          ),
          maxRepos,
          mode,
          forceFullScan,
          rulesetVersion,
          page: await this.resumePageFor(
            workspaceId,
            'code',
            half,
            continueDiscovery,
          ),
          searchKind: 'code',
          family,
          sizeSplitDepth: depth + 1,
          discoveryOnly: job.data.discoveryOnly,
        },
        job.opts.priority || 5,
      );
    }
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $inc: { awaitingSearch: halves.length },
    });
    this.logger.log(
      `Query "${query}" hit ${totalCount} total results (near the 1000 cap) - bisected its file-size range into 2 queries for scan ${scanJobId}`,
    );
    return true;
  }

  /**
   * Deterministic, stable synthetic queryIndex derived from the query text
   * itself rather than a counter - needed because date-range splitting can
   * recurse to any depth (a half can itself be split into quarters, and so
   * on), so there's no fixed "how many children will this ever have" to
   * count against like the one-level language split has. Same query text
   * always maps to the same index, so re-processing the same split query
   * (e.g. a retried job) doesn't create a duplicate checkpoint entry.
   */
  private static syntheticQueryIndex(base: number, query: string): number {
    let hash = 0;
    for (let i = 0; i < query.length; i += 1) {
      hash = (hash * 31 + query.charCodeAt(i)) >>> 0;
    }
    return base + (hash % GitHubSearchProcessor.DATE_SPLIT_QUERY_INDEX_RANGE);
  }

  /**
   * Recursive overflow relief for REPOSITORY search - see
   * splitCreatedRangeQuery. Fires on ANY repository query near the 1000
   * cap, whether or not the scan itself opted into a date filter -
   * ensureBoundedCreatedRange normalizes an unbounded (`>=`/`<=`) or
   * entirely absent `created:` qualifier into a full bounded range first,
   * so a brand-agnostic or otherwise never-date-scoped query gets exactly
   * the same relief a "Only today's repos" scan already did.
   *
   * Recursion is capped at MAX_DATE_SPLIT_DEPTH levels (2^depth leaf queries
   * worst case), NOT allowed to recurse all the way down to
   * splitCreatedRangeQuery's MIN_SPLIT_WIDTH_MS floor unconditionally.
   * Without this cap, a query with a genuinely huge total_count and no
   * brand narrowing (a common single-word brand-agnostic sweep against a
   * newly-synthesized ~18-year EARLIEST_SANE_DATE..today range) could
   * recurse dozens of levels deep before any half finally drops under the
   * threshold - each level doubling the number of real GitHub search
   * requests still owed, serialized against the 30/min (or 10/min code)
   * quota. That's not a rate-limit failure (quota is never actually
   * exhausted, so no pause is ever triggered - nothing to show a "limit
   * hit" message for) - it's the scan legitimately, silently taking
   * hours to grind through a self-inflicted request explosion, which reads
   * as "stuck" from the outside. Once the cap is hit, this query just falls
   * back to the plain exhausted/reset-to-page-1 behavior for whatever it
   * couldn't finish - graceful degradation, not a correctness bug.
   *
   * 10, not 6: each split only recurses into a half that's STILL over
   * DATE_RANGE_SPLIT_THRESHOLD, so the number of leaf queries actually
   * issued tracks the real total_count, not 2^depth blindly - a query with
   * an even 100,000-result spread needs only ceil(log2(100000/950)) ≈ 7
   * levels to get every leaf under the cap; depth 6 (the old cap) tops out
   * at ~54,000 in the typical case, silently losing the rest for anything
   * bigger - exactly the "50k, maybe even 100k" case this exists to cover.
   * 10 gives comfortable headroom (~970,000 in the typical, evenly-spread
   * case) while keeping the genuine worst case (a pathological distribution
   * where every branch needs to split all the way down) bounded at 2^10 =
   * 1024 requests - a few tens of minutes against the 30/min quota, not the
   * unbounded "hours" the cap exists to prevent.
   */
  private static readonly MAX_DATE_SPLIT_DEPTH = 10;

  private async maybeSplitOversizedDateRangeQuery(
    job: Job<GitHubSearchJobData>,
    totalCount: number,
    continueDiscovery: boolean,
  ): Promise<boolean> {
    const {
      workspaceId,
      scanJobId,
      query,
      maxRepos,
      mode,
      forceFullScan,
      rulesetVersion,
      family,
    } = job.data;
    const depth = job.data.splitDepth || 0;
    if (
      (job.data.searchKind || 'repositories') !== 'repositories' ||
      (job.data.page || 1) !== 1 ||
      depth >= GitHubSearchProcessor.MAX_DATE_SPLIT_DEPTH ||
      totalCount < GitHubSearchProcessor.DATE_RANGE_SPLIT_THRESHOLD
    ) {
      return false;
    }

    const halves = splitCreatedRangeQuery(ensureBoundedCreatedRange(query));
    if (!halves) return false;

    for (const half of halves) {
      await this.scanQueue.enqueueGithubSearch(
        {
          workspaceId,
          scanJobId,
          query: half,
          queryIndex: GitHubSearchProcessor.syntheticQueryIndex(
            GitHubSearchProcessor.DATE_SPLIT_QUERY_INDEX_BASE,
            half,
          ),
          maxRepos,
          mode,
          forceFullScan,
          rulesetVersion,
          page: await this.resumePageFor(
            workspaceId,
            'repositories',
            half,
            continueDiscovery,
          ),
          searchKind: 'repositories',
          family,
          splitDepth: depth + 1,
          discoveryOnly: job.data.discoveryOnly,
        },
        job.opts.priority || 5,
      );
    }
    await this.scanModel.findByIdAndUpdate(scanJobId, {
      $inc: { awaitingSearch: halves.length },
    });
    this.logger.log(
      `Query "${query}" hit ${totalCount} total results (near the 1000 cap) - bisected its date range into 2 queries for scan ${scanJobId}`,
    );
    return true;
  }
}
