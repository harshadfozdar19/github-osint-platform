import { createHash } from 'crypto';
import { redactSecretsInText } from '../common/utils/redact';

/** Build a stable config hash for duplicate active-scan prevention. */
export function buildScanConfigHash(input: {
  workspaceId: string;
  brandIds: string[];
  maxRepos: number;
  /** Scope marker (e.g. `brand:<id>` or `query:<raw query>`) so a scoped
   * scan is never treated as a duplicate of a full sweep, or of a
   * differently-scoped scan, sharing the same brand list/maxRepos. */
  scope?: string;
}): string {
  const payload = JSON.stringify({
    workspaceId: input.workspaceId,
    brandIds: [...input.brandIds].sort(),
    maxRepos: input.maxRepos,
    scope: input.scope,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

/** Strip secrets and truncate for safe persistence/logging. */
export function safeJobError(error: unknown, maxLen = 500): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  const redacted = redactSecretsInText(raw)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/ghp_[A-Za-z0-9]+/g, '[REDACTED]');
  return redacted.slice(0, maxLen);
}

export function defaultJobOptions(priority = 5) {
  return {
    attempts: Number(process.env.QUEUE_JOB_ATTEMPTS || 3),
    backoff: {
      type: 'exponential' as const,
      delay: Number(process.env.QUEUE_BACKOFF_MS || 2000),
    },
    removeOnComplete: 100,
    removeOnFail: 200,
    priority,
  };
}

/**
 * Background BullMQ maintenance (stalled-job scans, idle re-polling) runs on
 * every worker continuously, independent of whether any job is queued. With
 * 5 always-on workers this idle chatter is the dominant source of Redis
 * command volume on a low-traffic deployment (Upstash free tier bills per
 * command). BullMQ's defaults (30s stalled check, 5s idle re-poll) are tuned
 * for high-throughput queues; widen them here since recovering a genuinely
 * crashed job a minute or two later is a non-issue for this app's traffic.
 */
export function sharedWorkerTuning() {
  // stalledInterval is genuinely milliseconds, but BullMQ's `drainDelay` is
  // documented in *seconds* ("Number of seconds to long poll for jobs when
  // the queue is empty") — the env var stays in ms for consistency with
  // every other QUEUE_*_MS setting, and gets converted here.
  return {
    stalledInterval: Number(process.env.QUEUE_STALLED_INTERVAL_MS || 120_000),
    drainDelay: Math.round(
      Number(process.env.QUEUE_DRAIN_DELAY_MS || 15_000) / 1000,
    ),
  };
}

/** True when this process invocation is the last configured attempt. */
export function isFinalAttempt(job: {
  attemptsMade: number;
  opts: { attempts?: number };
}): boolean {
  const maxAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= maxAttempts;
}

/** Race a promise against a timeout; clears the timer on settle. */
export async function withJobTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
