import { createHash } from 'crypto';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

export function createRedisFromConfig(config: ConfigService): Redis {
  const url = config.get<string>('REDIS_URL')?.trim();
  if (url) {
    return new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });
  }
  return new Redis({
    host: config.get<string>('REDIS_HOST') || 'localhost',
    port: Number(config.get<string>('REDIS_PORT') || 6379),
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

export function etagCacheKey(method: string, path: string): string {
  const digest = createHash('sha256')
    .update(`${method.toUpperCase()}:${path}`)
    .digest('hex')
    .slice(0, 32);
  return `github:etag:${digest}`;
}

/** Exponential backoff with full jitter (AWS-style). */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * (exp + 1));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Request cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
