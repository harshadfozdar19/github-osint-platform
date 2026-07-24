import { Job, DelayedError } from 'bullmq';
import { isGitHubClientError } from '../github/github.errors';
import { GitHubService } from '../github/github.service';
import { ScanStateService } from '../scans/scan-state.service';

/**
 * If the error is a long rate-limit pause, delay the BullMQ job until reset
 * and throw DelayedError so the worker does not fail the attempt.
 * Returns false when the error is not a quota pause.
 */
export async function delayJobForGitHubQuota(
  job: Job,
  error: unknown,
  github: GitHubService,
  scanState: ScanStateService,
): Promise<boolean> {
  if (!isGitHubClientError(error)) return false;
  if (
    error.code !== 'RATE_LIMIT' &&
    error.code !== 'SECONDARY_RATE_LIMIT' &&
    error.code !== 'BUDGET'
  ) {
    return false;
  }

  const workspaceId = (job.data as { workspaceId?: string })?.workspaceId;
  const until =
    error.resetAt ||
    (await github.getPausedUntil(workspaceId)) ||
    Date.now() + (error.retryAfterMs || 60_000);

  const scanJobId = (job.data as { scanJobId?: string })?.scanJobId;
  if (scanJobId) {
    await github.markScanPause(scanJobId, until);
    await scanState.emitRateLimitPause(scanJobId, until);
  }

  const token = (job as Job & { token?: string }).token || '0';
  await job.moveToDelayed(until, token);
  throw new DelayedError(
    `Delayed for GitHub quota until ${new Date(until).toISOString()}`,
  );
}
