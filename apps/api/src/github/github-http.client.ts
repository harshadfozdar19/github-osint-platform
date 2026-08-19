import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { GitHubClientError, isGitHubClientError } from './github.errors';
import { GitHubRateLimitStore } from './github-rate-limit.store';
import {
  GitHubRequestContext,
  GitHubResource,
  TokenScope,
} from './github-rate-limit.types';
import { computeBackoffMs, etagCacheKey, sleep } from './github.utils';
import { WorkspacesService } from '../workspaces/workspaces.service';

export interface ManagedGitHubResponse<T> {
  data: T;
  status: number;
  notModified: boolean;
  headers: Record<string, string>;
}

@Injectable()
export class GitHubHttpClient {
  private readonly logger = new Logger(GitHubHttpClient.name);
  private readonly client: AxiosInstance;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly lowRemaining: number;
  private readonly pauseRemaining: number;
  private readonly workspaceDailyBudget: number;
  private readonly workspaceMaxConcurrency: number;
  private readonly globalMaxConcurrency: number;
  private readonly maxInlineWaitMs: number;
  /** Minimum ms between successive repo-search requests for the same token - see paceRequest. */
  private readonly searchMinIntervalMs: number;
  /** Minimum ms between successive code-search requests for the same token - code search's 10/min cap needs far more spacing than repo search's 30/min. */
  private readonly codeSearchMinIntervalMs: number;

  private readonly globalToken?: string;

  /**
   * GitHub's search API is the actual discovery bottleneck (30 req/min,
   * far stricter than the 5,000/hr core quota), and results for the exact
   * same public query rarely change within a few minutes - so an identical
   * search hit twice in a short window (overlapping keywords across brands,
   * a resumed scan re-issuing the same page) is answered from memory
   * instead of spending a real call. Search results are public GitHub data,
   * so this is shared across every workspace, not scoped to one. A cache
   * hit skips rate-limit/quota bookkeeping entirely too - zero Redis cost.
   */
  private readonly searchResultCache = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();
  private readonly searchCacheTtlMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly store: GitHubRateLimitStore,
    private readonly workspaces: WorkspacesService,
  ) {
    const token = this.config.get<string>('GITHUB_TOKEN')?.trim();
    this.globalToken = token;
    this.requestTimeoutMs = Number(
      this.config.get('GITHUB_REQUEST_TIMEOUT_MS') || 15_000,
    );
    this.maxAttempts = Number(this.config.get('GITHUB_RETRY_ATTEMPTS') || 3);
    this.backoffBaseMs = Number(
      this.config.get('GITHUB_RETRY_BACKOFF_MS') || 500,
    );
    this.backoffMaxMs = Number(
      this.config.get('GITHUB_RETRY_BACKOFF_MAX_MS') || 20_000,
    );
    this.lowRemaining = Number(this.config.get('GITHUB_RATE_LIMIT_LOW') || 20);
    this.pauseRemaining = Number(
      this.config.get('GITHUB_RATE_LIMIT_PAUSE_AT') || 5,
    );
    this.workspaceDailyBudget = Number(
      this.config.get('GITHUB_WORKSPACE_DAILY_BUDGET') || 5000,
    );
    this.workspaceMaxConcurrency = Number(
      this.config.get('MAX_CONCURRENT_REQUESTS') ||
        this.config.get('GITHUB_WORKSPACE_MAX_CONCURRENCY') ||
        2,
    );
    this.globalMaxConcurrency = Number(
      this.config.get('GITHUB_GLOBAL_MAX_CONCURRENCY') || 10,
    );
    this.maxInlineWaitMs = Number(
      this.config.get('GITHUB_MAX_INLINE_WAIT_MS') || 15_000,
    );
    this.searchCacheTtlMs = Number(
      this.config.get('GITHUB_SEARCH_DEDUP_CACHE_MS') || 180_000,
    );
    // Defaults leave a small margin under GitHub's actual caps (30/min repo
    // search, 10/min code search) rather than pacing right up against
    // them - this absorbs jitter/clock-skew across concurrent workers
    // without ever tripping the much costlier threshold-pause below.
    // Requests for one token/resource are already serialized one-at-a-time
    // via reserveNextSlot (never bursted), which is what actually keeps
    // this safe from GitHub's secondary/abuse rate limit - that limit is
    // triggered by bursts and concurrency, not by running close to the
    // primary per-minute cap on its own. ~5% margin (down from ~10%)
    // trades a bit of that jitter cushion for meaningfully faster
    // discovery; if pauses from GITHUB_LOW_REMAINING/PAUSE_REMAINING start
    // showing up more often, widen these back out.
    this.searchMinIntervalMs = Number(
      this.config.get('GITHUB_SEARCH_MIN_INTERVAL_MS') || 2100,
    );
    this.codeSearchMinIntervalMs = Number(
      this.config.get('GITHUB_CODE_SEARCH_MIN_INTERVAL_MS') || 6200,
    );

    this.client = axios.create({
      baseURL: 'https://api.github.com',
      timeout: this.requestTimeoutMs,
      headers: {
        // Authorization is set per-request (resolveToken) since it can be a
        // per-workspace token, not a fixed instance-level default.
        Accept: 'application/vnd.github+json',
        'User-Agent': 'github-osint-threat-platform',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      validateStatus: () => true,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('GITHUB_TOKEN')?.trim());
  }

  /** True if this workspace can make GitHub calls: its own token, or the shared one. */
  async isConfiguredForWorkspace(workspaceId?: string): Promise<boolean> {
    if (this.isConfigured()) return true;
    if (!workspaceId) return false;
    return Boolean(await this.resolveToken({ workspaceId }));
  }

  /**
   * Which Redis scope a request for this workspace would actually use.
   * Rate-limit snapshots, pause state, and budget must all be tracked per
   * scope — otherwise a rate-limit hit on the shared token would incorrectly
   * pause a workspace's own, completely separate GitHub quota (and vice
   * versa), and the shared-pool "daily budget" fairness cap would wrongly
   * keep applying to a workspace that isn't sharing anything anymore.
   */
  async scopeFor(workspaceId?: string): Promise<TokenScope> {
    const resolved = await this.resolveToken({ workspaceId });
    return resolved?.scope ?? 'shared';
  }

  /**
   * Resolves the token to use for a request: the calling workspace's own
   * encrypted token takes priority (decrypted in-memory only, briefly
   * cached), falling back to the shared GITHUB_TOKEN. Never logged, never
   * returned to a caller — used immediately to build one request's header.
   */
  private async resolveToken(
    ctx: GitHubRequestContext,
  ): Promise<{ token: string; scope: TokenScope } | undefined> {
    if (ctx.workspaceId) {
      try {
        const workspaceToken = await this.workspaces.resolveGithubToken(
          ctx.workspaceId,
        );
        if (workspaceToken) {
          return {
            token: workspaceToken,
            scope: `workspace:${ctx.workspaceId}`,
          };
        }
      } catch (error) {
        this.logger.warn(
          `Workspace GitHub token lookup failed for ${ctx.workspaceId}, falling back to shared token: ${(error as Error).message}`,
        );
      }
    }
    return this.globalToken
      ? { token: this.globalToken, scope: 'shared' }
      : undefined;
  }

  getThresholds() {
    return {
      lowRemaining: this.lowRemaining,
      pauseRemaining: this.pauseRemaining,
      workspaceDailyBudget: this.workspaceDailyBudget,
      workspaceMaxConcurrency: this.workspaceMaxConcurrency,
      globalMaxConcurrency: this.globalMaxConcurrency,
    };
  }

  /**
   * Calling GitHub's own /rate_limit endpoint doesn't count against the
   * quota it reports, and its response body carries every resource's
   * breakdown (core, search, ...) in one shot - unlike a normal request,
   * whose headers only ever reflect the one resource that request hit. Used
   * right after a workspace sets its own token so the quota panel has real
   * data immediately instead of waiting for the first live scan, and so an
   * invalid token surfaces as an error right away instead of silently
   * failing later mid-scan.
   *
   * Also clears any pause/secondary-backoff state already recorded for this
   * scope - scope is keyed by workspace id (`workspace:{id}`), not by the
   * token value itself, so swapping in a brand-new token does NOT change the
   * scope key. Without this, a workspace whose OLD token got paused for
   * exhausting its quota would still see every request blocked by that same
   * stale pause immediately after saving a fresh token that has never made
   * a single request yet. This is the only caller of this method, called
   * exactly once right after a token is saved - safe to unconditionally
   * clear here in a way that would NOT be safe from any other call site.
   */
  async refreshRateLimitSnapshot(ctx: GitHubRequestContext): Promise<void> {
    const resolved = await this.resolveToken(ctx);
    if (!resolved) return;
    await this.store.clearAllPauses(resolved.scope);
    await this.store.clearSecondary(resolved.scope);
    const res = await this.request<{
      resources: Record<
        string,
        { limit: number; remaining: number; reset: number; used: number }
      >;
    }>('GET', '/rate_limit', { ctx, resourceHint: 'core' });

    const now = Date.now();
    for (const resource of ['core', 'search'] as const) {
      const r = res.data.resources?.[resource];
      if (!r) continue;
      await this.store.saveSnapshot(resolved.scope, {
        resource,
        limit: r.limit,
        remaining: r.remaining,
        used: r.used,
        resetAt: r.reset * 1000,
        updatedAt: now,
      });
    }
  }

  private isSearchPath(path: string): boolean {
    return path.startsWith('/search/');
  }

  /**
   * Sole GitHub HTTP entrypoint. Handles budgets, pause, retries, ETags, timeouts.
   */
  async request<T>(
    method: 'GET' | 'HEAD',
    path: string,
    options: {
      params?: Record<string, string | number | boolean | undefined>;
      ctx?: GitHubRequestContext;
      useEtag?: boolean;
      resourceHint?: GitHubResource;
    } = {},
  ): Promise<ManagedGitHubResponse<T>> {
    const cacheable = method === 'GET' && this.isSearchPath(path);
    const cacheKey = cacheable
      ? `${path}?${JSON.stringify(options.params || {})}`
      : undefined;
    if (cacheKey) {
      const cached = this.searchResultCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value as ManagedGitHubResponse<T>;
      }
    }

    const ctx = options.ctx || {};
    const resolved = await this.resolveToken(ctx);
    if (!resolved) {
      throw new GitHubClientError(
        'GitHub token is not configured',
        'AUTH',
        401,
      );
    }
    const { token, scope } = resolved;

    this.throwIfAborted(ctx.signal);
    const resource =
      options.resourceHint || ctx.resource || this.classifyResource(path);

    await this.enforcePauseAndQuota(resource, ctx, scope);

    const workspaceId = ctx.workspaceId || 'global';
    // Daily budget is a fairness cap for workspaces sharing one token; it
    // must not apply once a workspace has switched to its own dedicated one.
    const usesSharedToken = scope === 'shared';
    if (ctx.workspaceId && usesSharedToken) {
      const used = await this.store.getBudgetUsed(ctx.workspaceId);
      if (used >= this.workspaceDailyBudget) {
        await this.store.incrMetric('budgetRejects');
        throw new GitHubClientError(
          'Workspace GitHub daily budget exhausted',
          'BUDGET',
        );
      }
    }

    const acquired = await this.store.acquireConcurrency(
      workspaceId,
      ctx.workspaceId
        ? this.workspaceMaxConcurrency
        : this.globalMaxConcurrency,
      this.globalMaxConcurrency,
    );
    if (!acquired) {
      await this.store.incrMetric('budgetRejects');
      // Unlike a real rate-limit pause (which can genuinely need up to a
      // minute to clear) or an exhausted daily budget, a concurrency-slot
      // rejection is transient - the workspace's in-flight requests are
      // capped at workspaceMaxConcurrency, and slots free up as soon as any
      // one of them completes, typically within a second or two. Without an
      // explicit retryAfterMs here, delayJobForGitHubQuota falls back to a
      // flat 60s delay, which - with several keyword-scoped scans
      // contending for the same small concurrency cap - makes every scan
      // past the first couple look stalled for up to a full minute at a
      // time instead of just waiting its short turn.
      throw new GitHubClientError(
        'GitHub concurrency limit reached for workspace or globally',
        'BUDGET',
        undefined,
        2_000,
      );
    }

    try {
      if (ctx.workspaceId && usesSharedToken) {
        await this.store.incrementBudget(ctx.workspaceId);
      }
      const result = await this.executeWithRetries<T>(
        method,
        path,
        resource,
        options,
        token,
        scope,
      );
      if (cacheKey) {
        this.searchResultCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + this.searchCacheTtlMs,
        });
      }
      return result;
    } finally {
      await this.store.releaseConcurrency(workspaceId);
    }
  }

  private async executeWithRetries<T>(
    method: 'GET' | 'HEAD',
    path: string,
    resource: GitHubResource,
    options: {
      params?: Record<string, string | number | boolean | undefined>;
      ctx?: GitHubRequestContext;
      useEtag?: boolean;
    },
    token: string,
    scope: TokenScope,
  ): Promise<ManagedGitHubResponse<T>> {
    const ctx = options.ctx || {};
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      this.throwIfAborted(ctx.signal);
      try {
        const result = await this.doRequest<T>(
          method,
          path,
          resource,
          options,
          token,
          scope,
        );
        return result;
      } catch (error) {
        lastError = error;
        if (!isGitHubClientError(error) || !error.retryable) {
          throw error;
        }
        if (attempt >= this.maxAttempts - 1) throw error;

        const retryAfter =
          error.retryAfterMs ??
          computeBackoffMs(attempt, this.backoffBaseMs, this.backoffMaxMs);
        await this.store.incrMetric('retriesTotal');
        this.logger.warn(
          JSON.stringify({
            event: 'github.retry',
            path,
            resource,
            attempt: attempt + 1,
            code: error.code,
            waitMs: retryAfter,
            workspaceId: ctx.workspaceId,
          }),
        );
        await sleep(retryAfter, ctx.signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new GitHubClientError('GitHub request failed', 'UNKNOWN');
  }

  private async doRequest<T>(
    method: 'GET' | 'HEAD',
    path: string,
    resource: GitHubResource,
    options: {
      params?: Record<string, string | number | boolean | undefined>;
      ctx?: GitHubRequestContext;
      useEtag?: boolean;
    },
    token: string,
    scope: TokenScope,
  ): Promise<ManagedGitHubResponse<T>> {
    const ctx = options.ctx || {};
    const cacheKey = etagCacheKey(method, this.cachePath(path, options.params));
    const cached =
      options.useEtag === true ? await this.store.getEtagEntry(cacheKey) : null;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const started = Date.now();
    let response: AxiosResponse;
    try {
      const config: AxiosRequestConfig = {
        method,
        url: path,
        params: options.params,
        headers,
        signal: ctx.signal,
        timeout: this.requestTimeoutMs,
      };
      response = await this.client.request(config);
    } catch (error) {
      if (axios.isCancel(error) || (error as Error)?.name === 'CanceledError') {
        throw new GitHubClientError('Request cancelled', 'CANCELLED');
      }
      if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
        throw new GitHubClientError('GitHub request timed out', 'TIMEOUT');
      }
      throw new GitHubClientError(
        'GitHub network failure',
        'NETWORK',
        undefined,
        computeBackoffMs(0, this.backoffBaseMs, this.backoffMaxMs),
      );
    }

    const headerMap = this.normalizeHeaders(response.headers);
    await this.ingestRateLimitHeaders(headerMap, resource, scope);
    await this.store.incrMetric('requestsTotal');

    const status = response.status;
    this.logger.log(
      JSON.stringify({
        event: 'github.request',
        method,
        path,
        status,
        resource,
        durationMs: Date.now() - started,
        remaining: headerMap['x-ratelimit-remaining'],
        workspaceId: ctx.workspaceId,
        // never log Authorization / tokens
      }),
    );

    if (status === 304 && cached) {
      return {
        data: JSON.parse(cached.body) as T,
        status: 304,
        notModified: true,
        headers: headerMap,
      };
    }

    if (status === 401) {
      throw new GitHubClientError(
        'GitHub authentication failed — check GITHUB_TOKEN',
        'AUTH',
        401,
      );
    }
    if (status === 403) {
      await this.handleForbidden(headerMap, response.data, scope, resource);
    }
    if (status === 429) {
      await this.handleRateLimitResponse(
        headerMap,
        resource,
        'RATE_LIMIT',
        scope,
      );
    }
    if (status === 422) {
      throw new GitHubClientError('GitHub validation error', 'VALIDATION', 422);
    }
    if (status === 404) {
      throw new GitHubClientError(
        'GitHub resource not found',
        'NOT_FOUND',
        404,
      );
    }
    if (status >= 400) {
      const retryable = status >= 500;
      throw new GitHubClientError(
        `GitHub API error (${status})`,
        retryable ? 'NETWORK' : 'UNKNOWN',
        status,
        retryable
          ? computeBackoffMs(0, this.backoffBaseMs, this.backoffMaxMs)
          : undefined,
      );
    }

    if (options.useEtag && headerMap.etag) {
      try {
        await this.store.setEtagEntry(
          cacheKey,
          headerMap.etag,
          JSON.stringify(response.data),
        );
      } catch {
        // cache write is best-effort
      }
    }

    return {
      data: response.data as T,
      status,
      notModified: false,
      headers: headerMap,
    };
  }

  private async handleForbidden(
    headers: Record<string, string>,
    body: unknown,
    scope: TokenScope,
    resource: GitHubResource,
  ): Promise<never> {
    const message = this.extractMessage(body);
    const secondary =
      /secondary rate limit|abuse detection/i.test(message) ||
      Boolean(headers['retry-after']);

    if (secondary || headers['x-ratelimit-remaining'] === '0') {
      // GitHub signals primary rate-limit exhaustion for search/code_search
      // via a 403 (not 429) - previously hardcoded to 'core' here regardless
      // of which resource the request actually was, so e.g. a code_search
      // 403 wrongly paused 'core' requests (unaffected, quota untouched)
      // while pausing on the WRONG key - each GitHub resource has its own
      // independent quota (see enforcePauseAndQuota's per-resource pause
      // lookup), so the pause must be attributed to the resource that was
      // actually exhausted.
      await this.handleRateLimitResponse(
        headers,
        secondary ? 'secondary' : resource,
        secondary ? 'SECONDARY_RATE_LIMIT' : 'RATE_LIMIT',
        scope,
      );
    }

    throw new GitHubClientError('GitHub permission denied', 'PERMISSION', 403);
  }

  private async handleRateLimitResponse(
    headers: Record<string, string>,
    resource: GitHubResource,
    code: 'RATE_LIMIT' | 'SECONDARY_RATE_LIMIT',
    scope: TokenScope,
  ): Promise<never> {
    await this.store.incrMetric(
      code === 'SECONDARY_RATE_LIMIT' ? 'secondaryHits' : 'rateLimitHits',
    );
    const retryAfterMs = this.parseRetryAfterMs(headers);
    const resetAt =
      this.parseResetAt(headers) ?? Date.now() + (retryAfterMs || 60_000);
    const until = Math.max(resetAt, Date.now() + (retryAfterMs || 0));

    if (code === 'SECONDARY_RATE_LIMIT') {
      await this.store.setSecondaryRetryAfterUntil(scope, until);
    }
    await this.store.setPause(scope, until, code, resource);
    await this.ingestRateLimitHeaders(headers, resource, scope);

    throw new GitHubClientError(
      code === 'SECONDARY_RATE_LIMIT'
        ? 'GitHub secondary rate limit'
        : 'GitHub primary rate limit',
      code,
      code === 'SECONDARY_RATE_LIMIT' ? 403 : 429,
      retryAfterMs || Math.max(0, until - Date.now()),
      until,
    );
  }

  async enforcePauseAndQuota(
    resource: GitHubResource,
    ctx: GitHubRequestContext,
    scope: TokenScope,
  ): Promise<void> {
    const secondaryUntil = await this.store.getSecondaryRetryAfterUntil(scope);
    if (secondaryUntil && secondaryUntil > Date.now()) {
      await this.delayOrThrow(secondaryUntil, ctx, 'secondary');
    }

    // Scoped to THIS request's resource only - a code_search pause must
    // never block a core or search request on the same token, since each
    // GitHub resource has its own independent quota (see getPause's doc).
    const pause = await this.store.getPause(scope, resource);
    if (pause.paused && pause.pausedUntil) {
      await this.delayOrThrow(
        pause.pausedUntil,
        ctx,
        pause.resource || resource,
      );
    }

    // Proactive pacing: space out search/code_search requests instead of
    // bursting until the threshold check below trips a pause. Bursting
    // then pausing for a full window reset (up to 60s) wastes far more
    // wall-clock time than spending the same budget evenly - and with
    // several keyword-scoped scans now able to run concurrently for the
    // same brand (same token), their requests would otherwise race each
    // other toward the same shared quota. reserveNextSlot is Redis-atomic
    // across all of them, so concurrent callers queue up in order rather
    // than all bursting together.
    await this.paceRequest(resource, ctx, scope);

    const snapshot = await this.store.getSnapshot(scope, resource);
    if (
      snapshot &&
      snapshot.remaining <= this.pauseRemaining &&
      snapshot.resetAt > Date.now()
    ) {
      await this.store.setPause(
        scope,
        snapshot.resetAt,
        'Nearly exhausted GitHub quota',
        resource,
      );
      await this.delayOrThrow(snapshot.resetAt, ctx, resource);
    }
  }

  /**
   * Proactive request pacing for search/code_search - a no-op for every
   * other resource (core's 5,000/hr budget has no need for it). Reserves
   * this request's slot via a Redis-atomic minimum-interval check, then
   * either sleeps inline (the common case - a single scan's own requests,
   * or a couple of concurrent keyword scans queuing a few seconds apart)
   * or - only when enough concurrent requests for the same resource have
   * piled up that the reserved slot is far enough out to not be worth
   * blocking a worker on - reschedules the job the same way a genuine
   * quota pause does (GitHubClientError('RATE_LIMIT'), picked up by
   * delayJobForGitHubQuota), freeing the worker to pick up other work
   * instead of sitting idle mid-sleep.
   */
  private async paceRequest(
    resource: GitHubResource,
    ctx: GitHubRequestContext,
    scope: TokenScope,
  ): Promise<void> {
    const minIntervalMs =
      resource === 'search'
        ? this.searchMinIntervalMs
        : resource === 'code_search'
          ? this.codeSearchMinIntervalMs
          : 0;
    if (minIntervalMs <= 0) return;

    const waitMs = await this.store.reserveNextSlot(
      scope,
      resource,
      minIntervalMs,
      this.maxInlineWaitMs,
    );
    if (waitMs <= 0) return;
    if (waitMs <= this.maxInlineWaitMs) {
      await sleep(waitMs, ctx.signal);
      return;
    }
    throw new GitHubClientError(
      `Pacing ${resource} requests - next slot in ${waitMs}ms`,
      'RATE_LIMIT',
      429,
      waitMs,
      Date.now() + waitMs,
    );
  }

  private async delayOrThrow(
    until: number,
    ctx: GitHubRequestContext,
    resource: GitHubResource,
  ): Promise<void> {
    const waitMs = until - Date.now();
    if (waitMs <= 0) return;
    if (ctx.scanJobId) {
      await this.store.markScanPaused(ctx.scanJobId, until);
    }
    if (waitMs <= this.maxInlineWaitMs) {
      this.logger.warn(
        JSON.stringify({
          event: 'github.wait',
          waitMs,
          resource,
          workspaceId: ctx.workspaceId,
          scanJobId: ctx.scanJobId,
        }),
      );
      await sleep(waitMs + Math.floor(Math.random() * 250), ctx.signal);
      if (ctx.scanJobId) await this.store.clearScanPaused(ctx.scanJobId);
      return;
    }
    throw new GitHubClientError(
      `GitHub quota paused until ${new Date(until).toISOString()}`,
      'RATE_LIMIT',
      429,
      waitMs,
      until,
    );
  }

  private async ingestRateLimitHeaders(
    headers: Record<string, string>,
    fallbackResource: GitHubResource,
    scope: TokenScope,
  ): Promise<void> {
    const limit = Number(headers['x-ratelimit-limit']);
    const remaining = Number(headers['x-ratelimit-remaining']);
    const used = Number(headers['x-ratelimit-used']);
    const resetSec = Number(headers['x-ratelimit-reset']);
    const resource =
      (headers['x-ratelimit-resource'] as GitHubResource) || fallbackResource;

    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;

    const resetAt = Number.isFinite(resetSec)
      ? resetSec * 1000
      : Date.now() + 60_000;

    await this.store.saveSnapshot(scope, {
      resource,
      limit,
      remaining,
      used: Number.isFinite(used) ? used : Math.max(0, limit - remaining),
      resetAt,
      updatedAt: Date.now(),
    });

    if (remaining <= this.pauseRemaining) {
      await this.store.setPause(
        scope,
        resetAt,
        'GitHub remaining requests below pause threshold',
        resource,
      );
    } else if (remaining > this.lowRemaining) {
      const pause = await this.store.getPause(scope, resource);
      if (pause.paused) {
        await this.store.clearPause(scope, resource);
      }
    }
  }

  private classifyResource(path: string): GitHubResource {
    if (path.startsWith('/search')) return 'search';
    if (path.startsWith('/graphql')) return 'graphql';
    return 'core';
  }

  private normalizeHeaders(
    headers: AxiosResponse['headers'],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (v === undefined || v === null) continue;
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
    }
    return out;
  }

  private parseRetryAfterMs(
    headers: Record<string, string>,
  ): number | undefined {
    const raw = headers['retry-after'];
    if (!raw) return undefined;
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) return Math.max(0, asNum * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return undefined;
  }

  private parseResetAt(headers: Record<string, string>): number | undefined {
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(reset) && reset > 0) return reset * 1000;
    return undefined;
  }

  private extractMessage(body: unknown): string {
    if (!body) return '';
    if (typeof body === 'string') return body;
    if (typeof body === 'object' && body !== null && 'message' in body) {
      return String(body.message);
    }
    return '';
  }

  private cachePath(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    if (!params) return path;
    const q = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('&');
    return q ? `${path}?${q}` : path;
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new GitHubClientError('Request cancelled', 'CANCELLED');
    }
  }
}
