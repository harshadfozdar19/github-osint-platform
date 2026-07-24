import { Types } from 'mongoose';
import { GitHubService } from './github.service';
import { ConfigService } from '@nestjs/config';

describe('GitHubService status API surface', () => {
  it('builds protected status with workspace budget and warnings', async () => {
    const workspaceId = new Types.ObjectId().toHexString();
    const http = {
      isConfigured: () => true,
      isConfiguredForWorkspace: () => Promise.resolve(true),
      scopeFor: () => Promise.resolve('shared' as const),
      getThresholds: () => ({
        lowRemaining: 20,
        pauseRemaining: 5,
        workspaceDailyBudget: 500,
        workspaceMaxConcurrency: 2,
        globalMaxConcurrency: 10,
      }),
    };
    const store = {
      getSnapshot: jest
        .fn()
        .mockImplementation((_scope: string, resource: string) =>
          Promise.resolve(
            resource === 'core'
              ? {
                  resource: 'core',
                  limit: 5000,
                  remaining: 10,
                  used: 4990,
                  resetAt: Date.now() + 60_000,
                  updatedAt: Date.now(),
                }
              : {
                  resource: 'search',
                  limit: 30,
                  remaining: 28,
                  used: 2,
                  resetAt: Date.now() + 60_000,
                  updatedAt: Date.now(),
                },
          ),
        ),
      getPause: jest.fn().mockResolvedValue({
        paused: false,
        pausedUntil: null,
        reason: null,
        resource: null,
      }),
      getSecondaryRetryAfterUntil: jest.fn().mockResolvedValue(null),
      getMetrics: jest.fn().mockResolvedValue({
        requestsTotal: 12,
        retriesTotal: 1,
        rateLimitHits: 0,
        budgetRejects: 0,
        secondaryHits: 0,
      }),
      countPausedScans: jest.fn().mockResolvedValue(2),
      workspaceBudget: jest.fn().mockResolvedValue({
        workspaceId,
        day: '2026-07-22',
        used: 40,
        limit: 500,
        remaining: 460,
        inFlight: 1,
        maxConcurrency: 2,
      }),
    };

    const service = new GitHubService(
      { get: () => '51200' } as unknown as ConfigService,
      http as never,
      store as never,
    );

    const status = await service.getStatus(workspaceId);
    expect(status.configured).toBe(true);
    expect(status.workspace?.remaining).toBe(460);
    expect(status.pausedScanCount).toBe(2);
    expect(status.warnings.some((w) => w.includes('quota low'))).toBe(true);
    expect(status.metrics.requestsTotal).toBe(12);
  });
});
