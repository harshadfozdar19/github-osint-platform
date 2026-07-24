import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createRedisFromConfig, utcDayKey } from './github.utils';
import {
  GitHubPauseState,
  GitHubRateLimitSnapshot,
  GitHubResource,
  REDIS_KEYS,
  TokenScope,
  WorkspaceGitHubBudget,
} from './github-rate-limit.types';

@Injectable()
export class GitHubRateLimitStore implements OnModuleDestroy {
  private readonly logger = new Logger(GitHubRateLimitStore.name);
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    this.redis = createRedisFromConfig(config);
    this.redis.on('error', (err) => {
      this.logger.warn(`Redis error (rate-limit store): ${err.message}`);
    });
  }

  get client(): Redis {
    return this.redis;
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  async getSnapshot(
    scope: TokenScope,
    resource: GitHubResource,
  ): Promise<GitHubRateLimitSnapshot | null> {
    const raw = await this.redis.hgetall(REDIS_KEYS.rateLimit(scope, resource));
    if (!raw || !raw.limit) return null;
    return {
      resource,
      limit: Number(raw.limit) || 0,
      remaining: Number(raw.remaining) || 0,
      used: Number(raw.used) || 0,
      resetAt: Number(raw.resetAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  }

  async saveSnapshot(
    scope: TokenScope,
    snapshot: GitHubRateLimitSnapshot,
  ): Promise<void> {
    const key = REDIS_KEYS.rateLimit(scope, snapshot.resource);
    await this.redis.hset(key, {
      limit: String(snapshot.limit),
      remaining: String(snapshot.remaining),
      used: String(snapshot.used),
      resetAt: String(snapshot.resetAt),
      updatedAt: String(snapshot.updatedAt),
      resource: snapshot.resource,
    });
    // Keep around through the reset window + buffer
    const ttlSec = Math.max(
      60,
      Math.ceil((snapshot.resetAt - Date.now()) / 1000) + 120,
    );
    await this.redis.expire(key, ttlSec);
  }

  async getPause(scope: TokenScope): Promise<GitHubPauseState> {
    const raw = await this.redis.hgetall(REDIS_KEYS.pause(scope));
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
      await this.clearPause(scope);
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
      resource: (raw.resource as GitHubResource) || null,
    };
  }

  async setPause(
    scope: TokenScope,
    pausedUntil: number,
    reason: string,
    resource: GitHubResource,
  ): Promise<void> {
    await this.redis.hset(REDIS_KEYS.pause(scope), {
      pausedUntil: String(pausedUntil),
      reason,
      resource,
    });
    const ttl = Math.max(1, Math.ceil((pausedUntil - Date.now()) / 1000) + 5);
    await this.redis.expire(REDIS_KEYS.pause(scope), ttl);
  }

  async clearPause(scope: TokenScope): Promise<void> {
    await this.redis.del(REDIS_KEYS.pause(scope));
  }

  async getSecondaryRetryAfterUntil(scope: TokenScope): Promise<number | null> {
    const raw = await this.redis.get(REDIS_KEYS.secondary(scope));
    if (!raw) return null;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= Date.now()) {
      await this.redis.del(REDIS_KEYS.secondary(scope));
      return null;
    }
    return until;
  }

  async setSecondaryRetryAfterUntil(
    scope: TokenScope,
    until: number,
  ): Promise<void> {
    const ttl = Math.max(1, Math.ceil((until - Date.now()) / 1000) + 5);
    await this.redis.set(REDIS_KEYS.secondary(scope), String(until), 'EX', ttl);
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

  async incrMetric(field: string, by = 1): Promise<void> {
    await this.redis.hincrby(REDIS_KEYS.metrics, field, by);
  }

  async getMetrics(): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(REDIS_KEYS.metrics);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      out[k] = Number(v) || 0;
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
