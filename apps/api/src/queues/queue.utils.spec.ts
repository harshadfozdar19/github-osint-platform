import {
  buildScanConfigHash,
  defaultJobOptions,
  isFinalAttempt,
  safeJobError,
  watchForCancellation,
} from './queue.utils';

describe('queue.utils', () => {
  it('builds stable config hashes', () => {
    const a = buildScanConfigHash({
      workspaceId: 'ws1',
      brandIds: ['b2', 'b1'],
      maxRepos: 25,
    });
    const b = buildScanConfigHash({
      workspaceId: 'ws1',
      brandIds: ['b1', 'b2'],
      maxRepos: 25,
    });
    const c = buildScanConfigHash({
      workspaceId: 'ws1',
      brandIds: ['b1', 'b2'],
      maxRepos: 10,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('redacts secrets from error messages', () => {
    const msg = safeJobError(
      new Error('failed token=ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
    );
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('provides exponential backoff defaults', () => {
    const opts = defaultJobOptions(3);
    expect(opts.attempts).toBeGreaterThanOrEqual(1);
    expect(opts.backoff.type).toBe('exponential');
    expect(opts.priority).toBe(3);
  });

  it('detects final attempts for retry-safe counter updates', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(
      false,
    );
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(
      true,
    );
  });

  describe('watchForCancellation', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('aborts the controller as soon as the scan is detected cancelled', async () => {
      let cancelled = false;
      const scanState = { isCancelled: jest.fn(async () => cancelled) };
      const abort = new AbortController();
      const stop = watchForCancellation(scanState, 'scan1', abort, 1000);

      await jest.advanceTimersByTimeAsync(1000);
      expect(abort.signal.aborted).toBe(false);

      cancelled = true;
      await jest.advanceTimersByTimeAsync(1000);
      expect(abort.signal.aborted).toBe(true);

      stop();
    });

    it('never aborts while the scan stays active', async () => {
      const scanState = { isCancelled: jest.fn(async () => false) };
      const abort = new AbortController();
      const stop = watchForCancellation(scanState, 'scan1', abort, 1000);

      await jest.advanceTimersByTimeAsync(5000);
      expect(abort.signal.aborted).toBe(false);
      expect(scanState.isCancelled).toHaveBeenCalledTimes(5);

      stop();
    });

    it('stops polling once the cleanup function is called', async () => {
      const scanState = { isCancelled: jest.fn(async () => false) };
      const abort = new AbortController();
      const stop = watchForCancellation(scanState, 'scan1', abort, 1000);

      await jest.advanceTimersByTimeAsync(2000);
      expect(scanState.isCancelled).toHaveBeenCalledTimes(2);

      stop();
      await jest.advanceTimersByTimeAsync(5000);
      // No further calls after cleanup - the interval is genuinely cleared.
      expect(scanState.isCancelled).toHaveBeenCalledTimes(2);
    });

    it('does not throw or abort when the cancellation check itself errors', async () => {
      const scanState = {
        isCancelled: jest.fn(async () => {
          throw new Error('transient DB error');
        }),
      };
      const abort = new AbortController();
      const stop = watchForCancellation(scanState, 'scan1', abort, 1000);

      await jest.advanceTimersByTimeAsync(1000);
      expect(abort.signal.aborted).toBe(false);

      stop();
    });
  });
});
