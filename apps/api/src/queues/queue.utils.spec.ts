import {
  buildScanConfigHash,
  defaultJobOptions,
  isFinalAttempt,
  safeJobError,
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
});
