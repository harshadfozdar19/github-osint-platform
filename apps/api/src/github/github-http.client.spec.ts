/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method */
import { ConfigService } from '@nestjs/config';
import { GitHubHttpClient } from './github-http.client';
import { GitHubRateLimitStore } from './github-rate-limit.store';
import { GitHubClientError } from './github.errors';
import { computeBackoffMs } from './github.utils';

const mockRequest = jest.fn();

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      create: () => ({
        request: mockRequest,
      }),
      isAxiosError: actual.default.isAxiosError,
      isCancel: actual.default.isCancel,
    },
    create: () => ({
      request: mockRequest,
    }),
  };
});

function buildClient(storeOverrides: Partial<GitHubRateLimitStore> = {}) {
  const store = {
    getPause: jest.fn().mockResolvedValue({
      paused: false,
      pausedUntil: null,
      reason: null,
      resource: null,
    }),
    getSecondaryRetryAfterUntil: jest.fn().mockResolvedValue(null),
    getSnapshot: jest.fn().mockResolvedValue(null),
    saveSnapshot: jest.fn().mockResolvedValue(undefined),
    setPause: jest.fn().mockResolvedValue(undefined),
    clearPause: jest.fn().mockResolvedValue(undefined),
    setSecondaryRetryAfterUntil: jest.fn().mockResolvedValue(undefined),
    getBudgetUsed: jest.fn().mockResolvedValue(0),
    incrementBudget: jest.fn().mockResolvedValue(1),
    acquireConcurrency: jest.fn().mockResolvedValue(true),
    releaseConcurrency: jest.fn().mockResolvedValue(undefined),
    incrMetric: jest.fn().mockResolvedValue(undefined),
    markScanPaused: jest.fn().mockResolvedValue(undefined),
    clearScanPaused: jest.fn().mockResolvedValue(undefined),
    getEtagEntry: jest.fn().mockResolvedValue(null),
    setEtagEntry: jest.fn().mockResolvedValue(undefined),
    ...storeOverrides,
  } as unknown as GitHubRateLimitStore;

  const config = {
    get: (key: string) => {
      const map: Record<string, string> = {
        GITHUB_TOKEN: 'ghp_testtoken_not_a_real_secret_0001',
        GITHUB_REQUEST_TIMEOUT_MS: '5000',
        GITHUB_RETRY_ATTEMPTS: '3',
        GITHUB_RETRY_BACKOFF_MS: '1',
        GITHUB_RETRY_BACKOFF_MAX_MS: '5',
        GITHUB_RATE_LIMIT_LOW: '20',
        GITHUB_RATE_LIMIT_PAUSE_AT: '5',
        GITHUB_WORKSPACE_DAILY_BUDGET: '100',
        GITHUB_WORKSPACE_MAX_CONCURRENCY: '2',
        GITHUB_GLOBAL_MAX_CONCURRENCY: '10',
        GITHUB_MAX_INLINE_WAIT_MS: '50',
      };
      return map[key];
    },
  } as unknown as ConfigService;

  const workspaces = {
    resolveGithubToken: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../workspaces/workspaces.service').WorkspacesService;

  const client = new GitHubHttpClient(config, store, workspaces);
  return { client, store, workspaces };
}

function headers(extra: Record<string, string> = {}) {
  return {
    'x-ratelimit-limit': '30',
    'x-ratelimit-remaining': '25',
    'x-ratelimit-used': '5',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    'x-ratelimit-resource': 'search',
    ...extra,
  };
}

describe('computeBackoffMs', () => {
  it('stays within exponential bounds', () => {
    for (let i = 0; i < 20; i += 1) {
      const ms = computeBackoffMs(2, 100, 1000);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(1000);
    }
  });
});

describe('GitHubHttpClient rate-limit management', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('handles a normal successful request and tracks headers', async () => {
    const { client, store } = buildClient();
    mockRequest.mockResolvedValue({
      status: 200,
      data: { total_count: 1, items: [] },
      headers: headers(),
    });

    const res = await client.request('GET', '/search/repositories', {
      params: { q: 'phonepe' },
      ctx: { workspaceId: 'ws1' },
      resourceHint: 'search',
    });

    expect(res.status).toBe(200);
    expect(store.saveSnapshot).toHaveBeenCalled();
    expect(store.incrementBudget).toHaveBeenCalledWith('ws1');
    expect(store.releaseConcurrency).toHaveBeenCalled();
  });

  it('pauses when remaining is near exhaustion', async () => {
    const resetAt = Date.now() + 30;
    const { client, store } = buildClient({
      getSnapshot: jest.fn().mockResolvedValue({
        resource: 'search',
        limit: 30,
        remaining: 3,
        used: 27,
        resetAt,
        updatedAt: Date.now(),
      }),
    });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { ok: true },
      headers: headers({ 'x-ratelimit-remaining': '3' }),
    });

    await client.request('GET', '/search/repositories', {
      ctx: { workspaceId: 'ws1', scanJobId: 'scan1' },
      resourceHint: 'search',
    });
    expect(store.setPause).toHaveBeenCalled();
    expect(store.markScanPaused).toHaveBeenCalled();
  });

  it('respects Retry-After on secondary rate limit', async () => {
    const { client, store } = buildClient();
    mockRequest.mockResolvedValue({
      status: 403,
      data: { message: 'You have exceeded a secondary rate limit' },
      headers: headers({
        'retry-after': '1',
        'x-ratelimit-remaining': '20',
      }),
    });

    await expect(
      client.request('GET', '/repos/a/b/contents', {
        ctx: { workspaceId: 'ws1' },
      }),
    ).rejects.toMatchObject({ code: 'SECONDARY_RATE_LIMIT' });
    expect(store.setSecondaryRetryAfterUntil).toHaveBeenCalled();
  });

  it('throws RATE_LIMIT on exhausted primary quota (429)', async () => {
    const { client, store } = buildClient();
    mockRequest.mockResolvedValue({
      status: 429,
      data: { message: 'API rate limit exceeded' },
      headers: headers({
        'x-ratelimit-remaining': '0',
        'retry-after': '2',
      }),
    });

    await expect(
      client.request('GET', '/search/repositories', {
        ctx: { workspaceId: 'ws1' },
        resourceHint: 'search',
      }),
    ).rejects.toBeInstanceOf(GitHubClientError);
    expect(store.incrMetric).toHaveBeenCalledWith('rateLimitHits');
  });

  it('does not retry authentication errors', async () => {
    const { client } = buildClient();
    mockRequest.mockResolvedValue({
      status: 401,
      data: { message: 'Bad credentials' },
      headers: headers(),
    });

    await expect(
      client.request('GET', '/user', { ctx: { workspaceId: 'ws1' } }),
    ).rejects.toMatchObject({ code: 'AUTH' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('does not retry validation errors', async () => {
    const { client } = buildClient();
    mockRequest.mockResolvedValue({
      status: 422,
      data: { message: 'Validation Failed' },
      headers: headers(),
    });

    await expect(
      client.request('GET', '/search/repositories', {
        params: { q: '' },
        ctx: { workspaceId: 'ws1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('retries network failures with bounded attempts', async () => {
    const { client } = buildClient();
    mockRequest
      .mockRejectedValueOnce({
        isAxiosError: true,
        code: 'ECONNRESET',
        message: 'socket hang up',
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { ok: true },
        headers: headers(),
      });

    // Force network classification via thrown non-timeout error path
    const axios = jest.requireMock('axios');
    axios.default.isAxiosError = () => true;

    const res = await client.request('GET', '/repos/a/b', {
      ctx: { workspaceId: 'ws1' },
    });
    expect(res.status).toBe(200);
    expect(mockRequest.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects when workspace daily budget is exhausted (shared token)', async () => {
    const { client, store } = buildClient({
      getBudgetUsed: jest.fn().mockResolvedValue(100),
    });

    await expect(
      client.request('GET', '/search/repositories', {
        ctx: { workspaceId: 'ws1' },
      }),
    ).rejects.toMatchObject({ code: 'BUDGET' });
    expect(store.incrMetric).toHaveBeenCalledWith('budgetRejects');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("does not apply the shared daily budget when the workspace uses its own token, even if the counter is already 'exhausted'", async () => {
    const { client, store, workspaces } = buildClient({
      getBudgetUsed: jest.fn().mockResolvedValue(100),
    });
    (workspaces.resolveGithubToken as jest.Mock).mockResolvedValue(
      'ghp_workspace_specific_token_00000000000001',
    );
    mockRequest.mockResolvedValue({
      status: 200,
      data: { ok: true },
      headers: headers(),
    });

    const res = await client.request('GET', '/search/repositories', {
      ctx: { workspaceId: 'ws1' },
    });

    expect(res.status).toBe(200);
    expect(store.incrementBudget).not.toHaveBeenCalled();
  });

  it("a shared-token pause does not block a workspace's own separately-scoped token", async () => {
    const { client, store, workspaces } = buildClient({
      getPause: jest.fn().mockImplementation((scope: string) =>
        Promise.resolve(
          scope === 'shared'
            ? {
                paused: true,
                pausedUntil: Date.now() + 60_000,
                reason: 'shared token rate limited',
                resource: 'core',
              }
            : {
                paused: false,
                pausedUntil: null,
                reason: null,
                resource: null,
              },
        ),
      ),
    });
    (workspaces.resolveGithubToken as jest.Mock).mockResolvedValue(
      'ghp_workspace_specific_token_00000000000001',
    );
    mockRequest.mockResolvedValue({
      status: 200,
      data: { ok: true },
      headers: headers(),
    });

    const res = await client.request('GET', '/repos/a/b', {
      ctx: { workspaceId: 'ws1' },
    });

    expect(res.status).toBe(200);
    expect(store.getPause).toHaveBeenCalledWith('workspace:ws1');
  });

  it('rejects when concurrency slots are unavailable (fairness)', async () => {
    const { client } = buildClient({
      acquireConcurrency: jest.fn().mockResolvedValue(false),
    });

    await expect(
      client.request('GET', '/search/repositories', {
        ctx: { workspaceId: 'ws1' },
      }),
    ).rejects.toMatchObject({ code: 'BUDGET' });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('uses ETag conditional requests and returns cached body on 304', async () => {
    const { client, store } = buildClient({
      getEtagEntry: jest.fn().mockResolvedValue({
        etag: '"abc"',
        body: JSON.stringify({ path: 'README.md', cached: true }),
      }),
    });
    mockRequest.mockResolvedValue({
      status: 304,
      data: '',
      headers: { ...headers(), etag: '"abc"' },
    });

    const res = await client.request<{ path: string; cached: boolean }>(
      'GET',
      '/repos/a/b/readme',
      { ctx: { workspaceId: 'ws1' }, useEtag: true },
    );
    expect(res.notModified).toBe(true);
    expect(res.data.cached).toBe(true);
    expect(store.getEtagEntry).toHaveBeenCalled();
  });

  it("prefers the workspace's own GitHub token over the shared one", async () => {
    const { client, workspaces } = buildClient();
    (workspaces.resolveGithubToken as jest.Mock).mockResolvedValue(
      'ghp_workspace_specific_token_00000000000001',
    );
    mockRequest.mockResolvedValue({
      status: 200,
      data: { ok: true },
      headers: headers(),
    });

    await client.request('GET', '/repos/a/b', {
      ctx: { workspaceId: 'ws1' },
    });

    expect(workspaces.resolveGithubToken).toHaveBeenCalledWith('ws1');
    const call = mockRequest.mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(call.headers.Authorization).toBe(
      'Bearer ghp_workspace_specific_token_00000000000001',
    );
  });

  it('falls back to the shared token when the workspace has none', async () => {
    const { client } = buildClient();
    mockRequest.mockResolvedValue({
      status: 200,
      data: { ok: true },
      headers: headers(),
    });

    await client.request('GET', '/repos/a/b', {
      ctx: { workspaceId: 'ws1' },
    });

    const call = mockRequest.mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(call.headers.Authorization).toBe(
      'Bearer ghp_testtoken_not_a_real_secret_0001',
    );
  });

  it('throws AUTH when neither a workspace token nor a shared token is configured', async () => {
    const store = {
      getPause: jest.fn().mockResolvedValue({
        paused: false,
        pausedUntil: null,
        reason: null,
        resource: null,
      }),
    } as unknown as GitHubRateLimitStore;
    const config = {
      get: () => undefined,
    } as unknown as ConfigService;
    const workspaces = {
      resolveGithubToken: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../workspaces/workspaces.service').WorkspacesService;
    const client = new GitHubHttpClient(config, store, workspaces);

    await expect(
      client.request('GET', '/repos/a/b', { ctx: { workspaceId: 'ws1' } }),
    ).rejects.toMatchObject({ code: 'AUTH' });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('coordinates pause state across workers via shared store', async () => {
    const pauseUntil = Date.now() + 40;
    const { client, store } = buildClient({
      getPause: jest
        .fn()
        .mockResolvedValueOnce({
          paused: true,
          pausedUntil: pauseUntil,
          reason: 'shared pause',
          resource: 'core',
        })
        .mockResolvedValue({
          paused: false,
          pausedUntil: null,
          reason: null,
          resource: null,
        }),
    });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { ok: true },
      headers: headers(),
    });

    await client.request('GET', '/repos/a/b', {
      ctx: { workspaceId: 'ws1', scanJobId: 's1' },
    });
    expect(store.markScanPaused).toHaveBeenCalled();
  });
});

describe('GitHubHttpClient search result caching', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('answers an identical search call from cache without a real request', async () => {
    const { client, store } = buildClient();
    mockRequest.mockResolvedValue({
      status: 200,
      data: { total_count: 1, items: [{ id: 1 }] },
      headers: headers(),
    });

    const first = await client.request('GET', '/search/repositories', {
      params: { q: 'zerodha' },
      ctx: { workspaceId: 'ws1' },
      resourceHint: 'search',
    });
    const second = await client.request('GET', '/search/repositories', {
      params: { q: 'zerodha' },
      ctx: { workspaceId: 'ws2' },
      resourceHint: 'search',
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // A cache hit skips rate-limit bookkeeping entirely.
    expect(store.acquireConcurrency).toHaveBeenCalledTimes(1);
  });

  it('treats different query params as different cache entries', async () => {
    const { client } = buildClient();
    mockRequest.mockResolvedValue({
      status: 200,
      data: { total_count: 0, items: [] },
      headers: headers(),
    });

    await client.request('GET', '/search/repositories', {
      params: { q: 'zerodha' },
      ctx: { workspaceId: 'ws1' },
      resourceHint: 'search',
    });
    await client.request('GET', '/search/repositories', {
      params: { q: 'groww' },
      ctx: { workspaceId: 'ws1' },
      resourceHint: 'search',
    });

    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('does not cache non-search paths', async () => {
    const { client } = buildClient();
    mockRequest.mockResolvedValue({
      status: 200,
      data: { ok: true },
      headers: headers(),
    });

    await client.request('GET', '/repos/a/b', { ctx: { workspaceId: 'ws1' } });
    await client.request('GET', '/repos/a/b', { ctx: { workspaceId: 'ws1' } });

    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('expires the cache entry after the configured TTL', async () => {
    const config = {
      get: (key: string) => {
        const map: Record<string, string> = {
          GITHUB_TOKEN: 'ghp_testtoken_not_a_real_secret_0001',
          GITHUB_RETRY_ATTEMPTS: '1',
          GITHUB_SEARCH_DEDUP_CACHE_MS: '5',
        };
        return map[key];
      },
    } as unknown as ConfigService;
    const store = {
      getPause: jest.fn().mockResolvedValue({
        paused: false,
        pausedUntil: null,
        reason: null,
        resource: null,
      }),
      getSecondaryRetryAfterUntil: jest.fn().mockResolvedValue(null),
      getSnapshot: jest.fn().mockResolvedValue(null),
      saveSnapshot: jest.fn().mockResolvedValue(undefined),
      getBudgetUsed: jest.fn().mockResolvedValue(0),
      incrementBudget: jest.fn().mockResolvedValue(1),
      acquireConcurrency: jest.fn().mockResolvedValue(true),
      releaseConcurrency: jest.fn().mockResolvedValue(undefined),
      incrMetric: jest.fn().mockResolvedValue(undefined),
    } as unknown as GitHubRateLimitStore;
    const workspaces = {
      resolveGithubToken: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../workspaces/workspaces.service').WorkspacesService;
    const client = new GitHubHttpClient(config, store, workspaces);
    mockRequest.mockResolvedValue({
      status: 200,
      data: { total_count: 0, items: [] },
      headers: headers(),
    });

    await client.request('GET', '/search/repositories', {
      params: { q: 'zerodha' },
      ctx: { workspaceId: 'ws1' },
      resourceHint: 'search',
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await client.request('GET', '/search/repositories', {
      params: { q: 'zerodha' },
      ctx: { workspaceId: 'ws1' },
      resourceHint: 'search',
    });

    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});
