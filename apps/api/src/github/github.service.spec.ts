import { Types } from 'mongoose';
import { GitHubService } from './github.service';
import { GitHubClientError } from './github.errors';
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
      getAnyPause: jest.fn().mockResolvedValue({
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

describe('GitHubService.listRecentCommits', () => {
  it('captures commit message and author name from the same response', async () => {
    const http = {
      request: jest.fn().mockResolvedValue({
        data: [
          {
            sha: 'abc123',
            commit: {
              message: 'fix angelone integration',
              author: { name: 'Jane Dev' },
            },
          },
          { sha: 'def456', commit: {} },
        ],
      }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.listRecentCommits('acme', 'repo', 'main');
    expect(result).toEqual([
      {
        sha: 'abc123',
        message: 'fix angelone integration',
        authorName: 'Jane Dev',
      },
      { sha: 'def456', message: '', authorName: '' },
    ]);
  });

  it('returns an empty array for an unsafe sha without calling the API', async () => {
    const http = { request: jest.fn() };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.listRecentCommits(
      'acme',
      'repo',
      'sha; rm -rf /',
    );
    expect(result).toEqual([]);
    expect(http.request).not.toHaveBeenCalled();
  });
});

function repoFixture(id: number, login = 'acme-corp') {
  return {
    id,
    full_name: `${login}/repo-${id}`,
    html_url: `https://github.com/${login}/repo-${id}`,
    description: null,
    stargazers_count: 0,
    forks_count: 0,
    fork: false,
    language: null,
    topics: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    pushed_at: '2024-01-02T00:00:00Z',
    owner: { login },
    name: `repo-${id}`,
    size: 10,
  };
}

describe('GitHubService.listAllOwnerRepos', () => {
  it('exhaustively paginates the org endpoint when the owner is a real org', async () => {
    const http = {
      request: jest
        .fn()
        // page 1: full page (100) -> keep going
        .mockResolvedValueOnce({
          data: Array.from({ length: 100 }, (_, i) => repoFixture(i)),
        })
        // page 2: partial page -> stop
        .mockResolvedValueOnce({ data: [repoFixture(100)] }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.listAllOwnerRepos('acme-corp');
    expect(result).toHaveLength(101);
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(http.request).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/orgs/acme-corp/repos',
      expect.objectContaining({ params: expect.objectContaining({ page: 1 }) }),
    );
  });

  it('falls back to the user endpoint when the org endpoint 404s', async () => {
    const http = {
      request: jest
        .fn()
        .mockRejectedValueOnce(
          new GitHubClientError('not found', 'NOT_FOUND', 404),
        )
        .mockResolvedValueOnce({ data: [repoFixture(1, 'some-user')] }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.listAllOwnerRepos('some-user');
    expect(result).toHaveLength(1);
    expect(http.request).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/users/some-user/repos',
      expect.objectContaining({
        params: expect.objectContaining({ type: 'owner' }),
      }),
    );
  });

  it('rejects an invalid owner without calling the API', async () => {
    const http = { request: jest.fn() };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    await expect(
      service.listAllOwnerRepos('owner; rm -rf /'),
    ).rejects.toThrow();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('excludes forks - an internal audit should only cover repos the account actually authored, not upstream forks', async () => {
    const http = {
      request: jest.fn().mockResolvedValueOnce({
        data: [
          repoFixture(1),
          { ...repoFixture(2), fork: true },
          repoFixture(3),
        ],
      }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.listAllOwnerRepos('acme-corp');
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });
});

describe('GitHubService.getReadme', () => {
  it('returns the decoded text along with the actual resolved path', async () => {
    const http = {
      request: jest.fn().mockResolvedValue({
        data: {
          content: Buffer.from('# Hello').toString('base64'),
          encoding: 'base64',
          size: 7,
          path: 'docs/Readme.rst',
        },
      }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getReadme('acme-corp', 'repo');
    expect(result).toEqual({ text: '# Hello', path: 'docs/Readme.rst' });
  });

  it('returns empty text and no path when the repo has no README', async () => {
    const http = {
      request: jest
        .fn()
        .mockRejectedValue(
          new GitHubClientError('not found', 'NOT_FOUND', 404),
        ),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getReadme('acme-corp', 'repo');
    expect(result).toEqual({ text: '' });
  });
});

describe('GitHubService.listBranches', () => {
  it('maps every branch and flags which have branch protection on', async () => {
    const http = {
      request: jest.fn().mockResolvedValue({
        data: [
          { name: 'main', commit: { sha: 'abc123' }, protected: true },
          { name: 'feature/x', commit: { sha: 'def456' }, protected: false },
        ],
      }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.listBranches('acme-corp', 'repo');
    expect(result).toEqual([
      { name: 'main', sha: 'abc123', protected: true },
      { name: 'feature/x', sha: 'def456', protected: false },
    ]);
    expect(http.request).toHaveBeenCalledWith(
      'GET',
      '/repos/acme-corp/repo/branches',
      expect.objectContaining({ resourceHint: 'core' }),
    );
  });

  it('returns an empty list for a repo that no longer exists, instead of throwing', async () => {
    const http = {
      request: jest
        .fn()
        .mockRejectedValue(
          new GitHubClientError('not found', 'NOT_FOUND', 404),
        ),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    await expect(service.listBranches('acme-corp', 'gone')).resolves.toEqual(
      [],
    );
  });
});

describe('GitHubService.getUserProfile', () => {
  it('returns account age/followers/public repo count', async () => {
    const http = {
      request: jest.fn().mockResolvedValue({
        data: {
          created_at: '2015-03-01T00:00:00Z',
          followers: 42,
          public_repos: 17,
        },
      }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getUserProfile('acme-corp');
    expect(result).toEqual({
      createdAt: '2015-03-01T00:00:00Z',
      followers: 42,
      publicRepos: 17,
    });
    expect(http.request).toHaveBeenCalledWith(
      'GET',
      '/users/acme-corp',
      expect.objectContaining({ resourceHint: 'core' }),
    );
  });

  it('returns null when the account is not found (deleted/renamed)', async () => {
    const http = {
      request: jest
        .fn()
        .mockRejectedValue(
          new GitHubClientError('not found', 'NOT_FOUND', 404),
        ),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getUserProfile('ghost-account');
    expect(result).toBeNull();
  });

  it('rejects an owner name that is not a safe path segment', async () => {
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      {} as never,
      {} as never,
    );

    await expect(service.getUserProfile('../etc/passwd')).rejects.toThrow(
      GitHubClientError,
    );
  });
});

describe('GitHubService.getRepositoryPagesInfo', () => {
  it('returns the live URL and status when Pages is configured', async () => {
    const http = {
      request: jest.fn().mockResolvedValue({
        data: { html_url: 'https://evil.github.io/', status: 'built' },
      }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getRepositoryPagesInfo('evil', 'repo');
    expect(result).toEqual({ url: 'https://evil.github.io/', status: 'built' });
  });

  it('returns null (not an error) when the repo has no Pages site (404)', async () => {
    const http = {
      request: jest
        .fn()
        .mockRejectedValue(
          new GitHubClientError('not found', 'NOT_FOUND', 404),
        ),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getRepositoryPagesInfo('evil', 'repo');
    expect(result).toBeNull();
  });

  it('routes through the shared rate-limited http client, not a raw fetch', async () => {
    const http = {
      request: jest.fn().mockResolvedValue({ data: {} }),
    };
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    await service.getRepositoryPagesInfo('evil', 'repo', {
      workspaceId: 'ws1',
    });
    expect(http.request).toHaveBeenCalledWith(
      'GET',
      '/repos/evil/repo/pages',
      expect.objectContaining({ ctx: { workspaceId: 'ws1' } }),
    );
  });
});

describe('GitHubService.getLatestDeployment', () => {
  function buildHttp(overrides: {
    homepage?: string | null;
    deployment?: { id?: number; environment?: string } | null;
    status?: { state?: string; environment_url?: string; created_at?: string } | null;
  }) {
    return {
      request: jest.fn().mockImplementation((_method: string, path: string) => {
        if (path === '/repos/owner/repo') {
          return Promise.resolve({ data: { homepage: overrides.homepage } });
        }
        if (path === '/repos/owner/repo/deployments') {
          return Promise.resolve({
            data: overrides.deployment ? [overrides.deployment] : [],
          });
        }
        if (path.startsWith('/repos/owner/repo/deployments/')) {
          return Promise.resolve({
            data: overrides.status ? [overrides.status] : [],
          });
        }
        throw new Error(`unexpected path ${path}`);
      }),
    };
  }

  it('prefers the repo homepage over the auto-generated deployment URL', async () => {
    const http = buildHttp({
      homepage: 'https://clone.vercel.app',
      deployment: { id: 1, environment: 'Production' },
      status: {
        state: 'success',
        environment_url: 'https://clone-a1b2c3-team.vercel.app',
        created_at: '2026-01-01T00:00:00Z',
      },
    });
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getLatestDeployment('owner', 'repo');
    expect(result).toEqual({
      environment: 'Production',
      url: 'https://clone.vercel.app',
      state: 'success',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('falls back to the deployment status URL when the repo has no homepage set', async () => {
    const http = buildHttp({
      homepage: null,
      deployment: { id: 1, environment: 'Production' },
      status: {
        state: 'success',
        environment_url: 'https://clone-a1b2c3-team.vercel.app',
        created_at: '2026-01-01T00:00:00Z',
      },
    });
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getLatestDeployment('owner', 'repo');
    expect(result?.url).toBe('https://clone-a1b2c3-team.vercel.app');
  });

  it('returns null when there is no actual GitHub Deployment record, even if homepage is set', async () => {
    const http = buildHttp({
      homepage: 'https://totally-unrelated-site.com',
      deployment: null,
    });
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getLatestDeployment('owner', 'repo');
    expect(result).toBeNull();
  });

  it('returns null when the deployment has no status with an environment_url', async () => {
    const http = buildHttp({
      homepage: 'https://clone.vercel.app',
      deployment: { id: 1, environment: 'Production' },
      status: { state: 'success' },
    });
    const service = new GitHubService(
      { get: () => undefined } as unknown as ConfigService,
      http as never,
      {} as never,
    );

    const result = await service.getLatestDeployment('owner', 'repo');
    expect(result).toBeNull();
  });
});
