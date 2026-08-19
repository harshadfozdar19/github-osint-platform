import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createRedisFromConfig, utcDayKey } from './github.utils';
import {
  GitHubPauseState,
  GitHubRateLimitSnapshot,
  GitHubResource,
  PAUSABLE_RESOURCES,
  REDIS_KEYS,
  TokenScope,
  WorkspaceGitHubBudget,
} from './github-rate-limit.types';

@Injectable()
export class GitHubRateLimitStore implements OnModuleDestroy {
  private readonly logger = new Logger(GitHubRateLimitStore.name);
  private readonly redis: Redis;
  /**
   * Every single GitHub call re-reads pause/snapshot state before it's
   * allowed to proceed (`enforcePauseAndQuota`), which during a large scan
   * means these three reads dominate Redis command volume. None of them
   * need millisecond freshness — pausing a worker a second late is a
   * non-issue given the buffer already built into the pause thresholds —
   * so a short in-memory TTL collapses repeated reads within a burst of
   * calls into a single Redis round trip.
   */
  private readonly shortCache = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();
  private readonly shortCacheTtlMs: number;

  /**
   * Metrics are dashboard-informational counters, not correctness-critical
   * state — batching a burst of increments into one periodic flush instead
   * of one HINCRBY per GitHub call is a pure win with no safety tradeoff.
   */
  private readonly pendingMetrics = new Map<string, number>();
  private metricsFlushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Snapshot writes are throttled the same way, *except* when remaining
   * quota drops near the pause threshold — that case always flushes
   * immediately so pause detection is never delayed by the throttle.
   */
  private readonly pendingSnapshots = new Map<
    string,
    { scope: TokenScope; snapshot: GitHubRateLimitSnapshot }
  >();
  private readonly lastSnapshotFlush = new Map<string, number>();
  private snapshotFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly snapshotLowWaterMark: number;

  constructor(private readonly config: ConfigService) {
    this.redis = createRedisFromConfig(config);
    this.redis.on('error', (err) => {
      this.logger.warn(`Redis error (rate-limit store): ${err.message}`);
    });
    this.shortCacheTtlMs = Number(
      config.get('GITHUB_RATE_LIMIT_CACHE_MS') || 1000,
    );
    // Generous margin above the actual pause-at threshold so a throttled
    // write is never what stands between "should have paused" and doing so.
    this.snapshotLowWaterMark =
      Number(config.get('GITHUB_RATE_LIMIT_PAUSE_AT') || 5) + 15;
  }

  get client(): Redis {
    return this.redis;
  }

  async onModuleDestroy() {
    if (this.metricsFlushTimer) clearInterval(this.metricsFlushTimer);
    if (this.snapshotFlushTimer) clearInterval(this.snapshotFlushTimer);
    await this.flushMetrics().catch(() => undefined);
    await this.flushSnapshots().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.shortCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await load();
    this.shortCache.set(key, {
      value,
      expiresAt: Date.now() + this.shortCacheTtlMs,
    });
    return value;
  }

  async getSnapshot(
    scope: TokenScope,
    resource: GitHubResource,
  ): Promise<GitHubRateLimitSnapshot | null> {
    return this.cached(`snapshot:${scope}:${resource}`, async () => {
      const raw = await this.redis.hgetall(
        REDIS_KEYS.rateLimit(scope, resource),
      );
      if (!raw || !raw.limit) return null;
      return {
        resource,
        limit: Number(raw.limit) || 0,
        remaining: Number(raw.remaining) || 0,
        used: Number(raw.used) || 0,
        resetAt: Number(raw.resetAt) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
      };
    });
  }

  async saveSnapshot(
    scope: TokenScope,
    snapshot: GitHubRateLimitSnapshot,
  ): Promise<void> {
    const cacheKey = `snapshot:${scope}:${snapshot.resource}`;
    // Keep the read-cache authoritative immediately regardless of whether
    // this write actually reaches Redis yet, so callers never observe a
    // value staler than what this process itself already knows.
    this.shortCache.set(cacheKey, {
      value: snapshot,
      expiresAt: Date.now() + this.shortCacheTtlMs,
    });
    this.pendingSnapshots.set(cacheKey, { scope, snapshot });

    if (snapshot.remaining <= this.snapshotLowWaterMark) {
      await this.flushOneSnapshot(cacheKey);
      return;
    }

    const lastFlush = this.lastSnapshotFlush.get(cacheKey) || 0;
    if (Date.now() - lastFlush >= this.shortCacheTtlMs) {
      await this.flushOneSnapshot(cacheKey);
      return;
    }
    this.ensureSnapshotFlushTimer();
  }

  private async flushOneSnapshot(cacheKey: string): Promise<void> {
    const pending = this.pendingSnapshots.get(cacheKey);
    if (!pending) return;
    this.pendingSnapshots.delete(cacheKey);
    this.lastSnapshotFlush.set(cacheKey, Date.now());
    const { scope, snapshot } = pending;
    const key = REDIS_KEYS.rateLimit(scope, snapshot.resource);
    const ttlSec = Math.max(
      60,
      Math.ceil((snapshot.resetAt - Date.now()) / 1000) + 120,
    );
    await this.redis.hset(key, {
      limit: String(snapshot.limit),
      remaining: String(snapshot.remaining),
      used: String(snapshot.used),
      resetAt: String(snapshot.resetAt),
      updatedAt: String(snapshot.updatedAt),
      resource: snapshot.resource,
    });
    await this.redis.expire(key, ttlSec);
  }

  private async flushSnapshots(): Promise<void> {
    const keys = [...this.pendingSnapshots.keys()];
    for (const key of keys) {
      await this.flushOneSnapshot(key);
    }
  }

  private ensureSnapshotFlushTimer(): void {
    if (this.snapshotFlushTimer) return;
    this.snapshotFlushTimer = setInterval(() => {
      void this.flushSnapshots().catch((err: unknown) => {
        this.logger.warn(
          `Snapshot flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.shortCacheTtlMs);
    this.snapshotFlushTimer.unref?.();
  }

  /**
   * Pause state is keyed per (scope, resource) - a code_search exhaustion
   * must never block a core/search request on the same token, since each
   * GitHub resource has its own independent quota. This used to be one
   * pause record per scope covering every resource, which meant a code
   * search 429 (10 req/min, exhausted almost instantly by the
   * one-query-per-keyword discovery families) stalled repo-search queries
   * and repository-analysis REST calls too, for as long as the code_search
   * bucket took to reset - the dominant cause of scans stalling near
   * completion on just a couple of straggler jobs.
   */
  async getPause(
    scope: TokenScope,
    resource: GitHubResource,
  ): Promise<GitHubPauseState> {
    return this.cached(`pause:${scope}:${resource}`, async () => {
      const raw = await this.redis.hgetall(REDIS_KEYS.pause(scope, resource));
      if (!raw || !raw.pausedUntil) {
        return {
          paused: false,
          pausedUntil: null,
          reason: null,
          resource: null,
        };
      }
      const pausedUntil = Number(raw.pausedUntil) || 0;
      if (pausedUntil <= Date.now()) {
        await this.clearPause(scope, resource);
        return {
          paused: false,
          pausedUntil: null,
          reason: null,
          resource: null,
        };
      }
      return {
        paused: true,
        pausedUntil,
        reason: raw.reason || 'GitHub rate limit',
        resource: (raw.resource as GitHubResource) || resource,
      };
    });
  }

  async setPause(
    scope: TokenScope,
    pausedUntil: number,
    reason: string,
    resource: GitHubResource,
  ): Promise<void> {
    const key = REDIS_KEYS.pause(scope, resource);
    await this.redis.hset(key, {
      pausedUntil: String(pausedUntil),
      reason,
      resource,
    });
    const ttl = Math.max(1, Math.ceil((pausedUntil - Date.now()) / 1000) + 5);
    await this.redis.expire(key, ttl);
  }

  async clearPause(scope: TokenScope, resource: GitHubResource): Promise<void> {
    await this.redis.del(REDIS_KEYS.pause(scope, resource));
    // Otherwise a pause read that landed in the short in-memory cache just
    // before this clear would keep answering "still paused" for up to
    // shortCacheTtlMs after the Redis key is already gone.
    this.shortCache.delete(`pause:${scope}:${resource}`);
  }

  /** Clears every resource's pause for this scope - see refreshRateLimitSnapshot's token-rotation comment for why this must be unconditional there. */
  async clearAllPauses(scope: TokenScope): Promise<void> {
    for (const resource of PAUSABLE_RESOURCES) {
      await this.clearPause(scope, resource);
    }
  }

  /**
   * Status-display-only: "is anything paused for this scope, and until
   * when" collapsed across every resource, since a dashboard/health check
   * cares about the token as a whole, not one specific resource. Never used
   * to gate an actual outbound request - enforcePauseAndQuota always checks
   * the specific resource that request is for.
   */
  async getAnyPause(scope: TokenScope): Promise<GitHubPauseState> {
    let latest: GitHubPauseState = {
      paused: false,
      pausedUntil: null,
      reason: null,
      resource: null,
    };
    for (const resource of PAUSABLE_RESOURCES) {
      const pause = await this.getPause(scope, resource);
      if (
        pause.paused &&
        pause.pausedUntil &&
        (!latest.pausedUntil || pause.pausedUntil > latest.pausedUntil)
      ) {
        latest = pause;
      }
    }
    return latest;
  }

  /**
   * Reserves the next allowed request slot for (scope, resource), enforcing
   * a minimum spacing between successive requests instead of the reactive
   * "burst until near-exhausted, then pause for a full window reset"
   * behavior of the pause/snapshot checks. Returns how many ms the caller
   * must wait before it's actually this request's turn (0 if it can go
   * immediately).
   *
   * Atomic via a Lua script - a plain GET-then-SET here would let several
   * concurrent callers for the same resource (e.g. two keyword-scoped
   * scans for the same brand, both hitting code search at once) each read
   * the same stale "last request" timestamp and both conclude they're
   * clear to go right now, defeating the whole point of pacing. The script
   * reads the last reserved slot, bumps it forward by minIntervalMs (or to
   * now, whichever is later), and returns the wait - so concurrent callers
   * queue up single-file automatically rather than racing.
   *
   * Only actually CLAIMS (persists) that slot when the wait is within
   * maxInlineWaitMs - i.e. when the caller can actually honor it by
   * sleeping right now. A caller facing a longer wait doesn't sleep; it
   * throws and gets rescheduled via BullMQ instead (see
   * GitHubHttpClient.paceRequest/delayJobForGitHubQuota), WITHOUT ever
   * making the real GitHub request that slot was for. Regression: this
   * used to claim the slot unconditionally on every call, so every
   * rescheduled-and-abandoned attempt still permanently pushed the shared
   * "last reserved" pointer forward - under any burst of concurrent
   * callers (several keyword scans, or one query's recursive
   * language/date-split children, all sharing one resource's pacing key),
   * the backlog of claimed-but-never-fulfilled slots could grow faster
   * than real requests drained it, so the reported wait never converged
   * toward zero even minutes later. Leaving the pointer untouched when a
   * caller can't use its slot means the next attempt (a retry of this same
   * job, or any other caller) recomputes from the same real baseline
   * instead of an ever-inflating one.
   */
  async reserveNextSlot(
    scope: TokenScope,
    resource: GitHubResource,
    minIntervalMs: number,
    maxInlineWaitMs: number,
  ): Promise<number> {
    const key = REDIS_KEYS.pace(scope, resource);
    const script = `
      local last = tonumber(redis.call('GET', KEYS[1]) or '0')
      local now = tonumber(ARGV[1])
      local minInterval = tonumber(ARGV[2])
      local maxInlineWait = tonumber(ARGV[3])
      local nextSlot = last + minInterval
      local slot = nextSlot > now and nextSlot or now
      local wait = slot - now
      if wait <= maxInlineWait then
        redis.call('SET', KEYS[1], slot, 'PX', minInterval * 4)
      end
      return wait
    `;
    const waitMs = await this.redis.eval(
      script,
      1,
      key,
      String(Date.now()),
      String(minIntervalMs),
      String(maxInlineWaitMs),
    );
    return Math.max(0, Number(waitMs));
  }

  async getSecondaryRetryAfterUntil(scope: TokenScope): Promise<number | null> {
    return this.cached(`secondary:${scope}`, async () => {
      const raw = await this.redis.get(REDIS_KEYS.secondary(scope));
      if (!raw) return null;
      const until = Number(raw);
      if (!Number.isFinite(until) || until <= Date.now()) {
        await this.redis.del(REDIS_KEYS.secondary(scope));
        return null;
      }
      return until;
    });
  }

  async setSecondaryRetryAfterUntil(
    scope: TokenScope,
    until: number,
  ): Promise<void> {
    const ttl = Math.max(1, Math.ceil((until - Date.now()) / 1000) + 5);
    await this.redis.set(REDIS_KEYS.secondary(scope), String(until), 'EX', ttl);
  }

  /** See clearPause - same "don't let a token rotation inherit the old token's backoff" reasoning, for the secondary/abuse-detection cooldown. */
  async clearSecondary(scope: TokenScope): Promise<void> {
    await this.redis.del(REDIS_KEYS.secondary(scope));
    this.shortCache.delete(`secondary:${scope}`);
  }

  async incrementBudget(workspaceId: string): Promise<number> {
    const day = utcDayKey();
    const key = REDIS_KEYS.budget(workspaceId, day);
    const used = await this.redis.incr(key);
    if (used === 1) {
      await this.redis.expire(key, 60 * 60 * 48);
    }
    return used;
  }

  async getBudgetUsed(workspaceId: string): Promise<number> {
    const day = utcDayKey();
    const raw = await this.redis.get(REDIS_KEYS.budget(workspaceId, day));
    return Number(raw) || 0;
  }

  async acquireConcurrency(
    workspaceId: string,
    maxWorkspace: number,
    maxGlobal: number,
  ): Promise<boolean> {
    const wsKey = REDIS_KEYS.concurrency(workspaceId);
    const globalKey = REDIS_KEYS.globalConcurrency;
    // Lua: try incr both if under limits, else abort
    const script = `
      local ws = redis.call('INCR', KEYS[1])
      if ws == 1 then redis.call('EXPIRE', KEYS[1], 600) end
      if ws > tonumber(ARGV[1]) then
        redis.call('DECR', KEYS[1])
        return 0
      end
      local g = redis.call('INCR', KEYS[2])
      if g == 1 then redis.call('EXPIRE', KEYS[2], 600) end
      if g > tonumber(ARGV[2]) then
        redis.call('DECR', KEYS[2])
        redis.call('DECR', KEYS[1])
        return 0
      end
      return 1
    `;
    const ok = await this.redis.eval(
      script,
      2,
      wsKey,
      globalKey,
      String(maxWorkspace),
      String(maxGlobal),
    );
    return Number(ok) === 1;
  }

  async releaseConcurrency(workspaceId: string): Promise<void> {
    const wsKey = REDIS_KEYS.concurrency(workspaceId);
    const globalKey = REDIS_KEYS.globalConcurrency;
    const script = `
      local ws = tonumber(redis.call('GET', KEYS[1]) or '0')
      if ws > 0 then redis.call('DECR', KEYS[1]) end
      local g = tonumber(redis.call('GET', KEYS[2]) or '0')
      if g > 0 then redis.call('DECR', KEYS[2]) end
      return 1
    `;
    await this.redis.eval(script, 2, wsKey, globalKey);
  }

  async getInFlight(workspaceId: string): Promise<number> {
    return (
      Number(await this.redis.get(REDIS_KEYS.concurrency(workspaceId))) || 0
    );
  }

  async markScanPaused(scanJobId: string, until: number): Promise<void> {
    await this.redis.hset(REDIS_KEYS.pausedScans, scanJobId, String(until));
    await this.redis.expire(REDIS_KEYS.pausedScans, 60 * 60 * 6);
  }

  async clearScanPaused(scanJobId: string): Promise<void> {
    await this.redis.hdel(REDIS_KEYS.pausedScans, scanJobId);
  }

  /** Live pause state for one scan job - null once resumed/cleared or expired. */
  async getScanPausedUntil(scanJobId: string): Promise<number | null> {
    const raw = await this.redis.hget(REDIS_KEYS.pausedScans, scanJobId);
    const until = Number(raw) || 0;
    if (until <= Date.now()) return null;
    return until;
  }

  async countPausedScans(): Promise<number> {
    const all = await this.redis.hgetall(REDIS_KEYS.pausedScans);
    const now = Date.now();
    let count = 0;
    for (const [id, untilRaw] of Object.entries(all)) {
      const until = Number(untilRaw) || 0;
      if (until > now) count += 1;
      else await this.redis.hdel(REDIS_KEYS.pausedScans, id);
    }
    return count;
  }

  incrMetric(field: string, by = 1): Promise<void> {
    this.pendingMetrics.set(field, (this.pendingMetrics.get(field) || 0) + by);
    this.ensureMetricsFlushTimer();
    return Promise.resolve();
  }

  private async flushMetrics(): Promise<void> {
    if (this.pendingMetrics.size === 0) return;
    const entries = [...this.pendingMetrics.entries()];
    this.pendingMetrics.clear();
    for (const [field, by] of entries) {
      await this.redis.hincrby(REDIS_KEYS.metrics, field, by);
    }
  }

  private ensureMetricsFlushTimer(): void {
    if (this.metricsFlushTimer) return;
    this.metricsFlushTimer = setInterval(() => {
      void this.flushMetrics().catch((err: unknown) => {
        this.logger.warn(
          `Metrics flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.shortCacheTtlMs * 5);
    this.metricsFlushTimer.unref?.();
  }

  async getMetrics(): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(REDIS_KEYS.metrics);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      out[k] = Number(v) || 0;
    }
    // Merge not-yet-flushed increments so the live dashboard/status endpoint
    // never appears to undercount while a batch is still pending.
    for (const [field, by] of this.pendingMetrics.entries()) {
      out[field] = (out[field] || 0) + by;
    }
    return out;
  }

  async getEtagEntry(
    key: string,
  ): Promise<{ etag: string; body: string } | null> {
    const raw = await this.redis.hgetall(key);
    if (!raw?.etag) return null;
    return { etag: raw.etag, body: raw.body || '' };
  }

  async setEtagEntry(
    key: string,
    etag: string,
    body: string,
    ttlSec = 3600,
  ): Promise<void> {
    await this.redis.hset(key, { etag, body });
    await this.redis.expire(key, ttlSec);
  }

  async workspaceBudget(
    workspaceId: string,
    dailyLimit: number,
    maxConcurrency: number,
  ): Promise<WorkspaceGitHubBudget> {
    const day = utcDayKey();
    const used = await this.getBudgetUsed(workspaceId);
    const inFlight = await this.getInFlight(workspaceId);
    return {
      workspaceId,
      day,
      used,
      limit: dailyLimit,
      remaining: Math.max(0, dailyLimit - used),
      inFlight,
      maxConcurrency,
    };
  }
}
