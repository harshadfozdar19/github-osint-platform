import { Types } from 'mongoose';
import { GitHubSearchProcessor } from './github-search.processor';

describe('GitHubSearchProcessor (mocked GitHub)', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();

  it('enqueues repository analysis from mocked search results', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      matchBrand: jest.fn().mockReturnValue({
        _id: new Types.ObjectId(),
        name: 'PhonePe',
        aliases: ['phonepe'],
      }),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 101,
            full_name: 'evil/phonepe-login',
            html_url: 'https://github.com/evil/phonepe-login',
            description: 'PhonePe login clone',
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: 'Java',
            topics: ['apk'],
            created_at: '2024-01-01T00:00:00Z',
            pushed_at: '2024-01-02T00:00:00Z',
            owner: { login: 'evil' },
            name: 'phonepe-login',
          },
        ],
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '5' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve([
              {
                _id: new Types.ObjectId(),
                name: 'PhonePe',
                aliases: ['phonepe'],
              },
            ]),
        }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () => Promise.resolve({ reposDiscovered: 0 }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'phonepe apk',
        queryIndex: 0,
        maxRepos: 25,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(github.searchRepositories).toHaveBeenCalledWith(
      'phonepe apk',
      1,
      5,
      expect.objectContaining({ workspaceId, scanJobId }),
    );
    expect(scanQueue.enqueueRepositoryAnalysis).toHaveBeenCalled();
    const [analysisPayload, priority] = scanQueue.enqueueRepositoryAnalysis.mock
      .calls[0] as [
      {
        workspaceId: string;
        scanJobId: string;
        repo: { id: number; full_name: string };
      },
      number,
    ];
    expect(analysisPayload.workspaceId).toBe(workspaceId);
    expect(analysisPayload.scanJobId).toBe(scanJobId);
    expect(analysisPayload.repo.id).toBe(101);
    expect(analysisPayload.repo.full_name).toBe('evil/phonepe-login');
    expect(priority).toBe(5);
    expect(scanState.completeSearchJob).toHaveBeenCalledWith(scanJobId, 1);
  });

  it('skips live work when scan is cancelled', async () => {
    const scanQueue = { enqueueRepositoryAnalysis: jest.fn() };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(true),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest.fn(),
      clearScanPause: jest.fn(),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      {
        isAlreadyCompleted: jest.fn(),
        claimRepositoryForAnalysis: jest.fn(),
        saveCheckpoint: jest.fn(),
        currentRulesetVersion: jest.fn().mockReturnValue('r'),
      } as never,
      github as never,
      { get: () => '120000' } as never,
      {} as never,
      {} as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'x',
        queryIndex: 0,
        maxRepos: 10,
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(github.searchRepositories).not.toHaveBeenCalled();
    expect(scanState.completeSearchJob).toHaveBeenCalledWith(scanJobId, 0);
  });

  it('paginates to the next page and saves a search checkpoint', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = { matchBrand: jest.fn().mockReturnValue(undefined) };
    const github = {
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 20,
        incomplete_results: false,
        items: Array.from({ length: 5 }, (_, i) => ({
          id: 200 + i,
          full_name: `evil/repo-${i}`,
          html_url: `https://github.com/evil/repo-${i}`,
          description: null,
          stargazers_count: 0,
          forks_count: 0,
          fork: false,
          language: 'Go',
          topics: [],
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2024-01-02T00:00:00Z',
          owner: { login: 'evil' },
          name: `repo-${i}`,
        })),
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              reposDiscovered: 0,
              checkpoint: { searchCursors: { '0': 1 } },
            }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      github as never,
      {
        get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '5' : '120000'),
      } as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'phonepe apk',
        queryIndex: 0,
        maxRepos: 25,
        page: 2,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(github.searchRepositories).toHaveBeenCalledWith(
      'phonepe apk',
      2,
      5,
      expect.objectContaining({ workspaceId, scanJobId }),
    );
    expect(incremental.saveCheckpoint).toHaveBeenCalledWith(
      scanJobId,
      expect.objectContaining({
        searchCursors: expect.objectContaining({ '0': 2 }),
      }),
    );
    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3, queryIndex: 0 }),
      5,
    );
  });

  it('does not paginate when repo cap is reached', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 100,
        incomplete_results: false,
        items: Array.from({ length: 5 }, (_, i) => ({
          id: 300 + i,
          full_name: `evil/full-${i}`,
          html_url: `https://github.com/evil/full-${i}`,
          description: null,
          stargazers_count: 0,
          forks_count: 0,
          fork: false,
          language: 'Go',
          topics: [],
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2024-01-02T00:00:00Z',
          owner: { login: 'evil' },
          name: `full-${i}`,
        })),
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      { matchBrand: jest.fn() } as never,
      incremental as never,
      github as never,
      {
        get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '5' : '120000'),
      } as never,
      {
        find: jest.fn().mockReturnValue({
          lean: () => ({ exec: () => Promise.resolve([]) }),
        }),
      } as never,
      {
        findById: jest.fn().mockReturnValue({
          lean: () => ({
            exec: () =>
              Promise.resolve({ reposDiscovered: 24, checkpoint: {} }),
          }),
        }),
        findByIdAndUpdate: jest.fn().mockResolvedValue({}),
      } as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'secret',
        queryIndex: 1,
        maxRepos: 25,
        page: 1,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).not.toHaveBeenCalled();
  });
});
