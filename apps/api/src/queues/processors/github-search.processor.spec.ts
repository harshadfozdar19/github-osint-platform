import { Types } from 'mongoose';
import { GitHubSearchProcessor } from './github-search.processor';
import { CODE_SEARCH_SPLIT_LANGUAGES } from '../../scans/discovery/query-families';

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
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
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
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
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
        internalAudit?: boolean;
      },
      number,
    ];
    expect(analysisPayload.workspaceId).toBe(workspaceId);
    expect(analysisPayload.scanJobId).toBe(scanJobId);
    expect(analysisPayload.repo.id).toBe(101);
    expect(analysisPayload.repo.full_name).toBe('evil/phonepe-login');
    // Regression: omitting this left RepositoryAnalysisProcessor's
    // upsertRepository calls with internalAudit=undefined, which silently
    // never wrote Repository.origin at all - permanently hiding the repo
    // from the Repositories page's origin:'external' filter. This
    // processor only ever runs for external keyword/GitHub-search
    // discovery, so it must always be explicitly false here.
    expect(analysisPayload.internalAudit).toBe(false);
    expect(priority).toBe(5);
    expect(scanState.completeSearchJob).toHaveBeenCalledWith(scanJobId, 1);
  });

  it("drops code-search results outside the scan's date window without claiming or enqueueing them (GitHub code search has no created:/pushed: qualifier, so this is enforced client-side)", async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = { matchBrand: jest.fn() };
    const today = new Date();
    const threeYearsAgo = new Date(
      today.getFullYear() - 3,
      today.getMonth(),
      today.getDate(),
    );
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchCode: jest.fn().mockResolvedValue({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            id: 201,
            full_name: 'zerodha-clone/pushed-today',
            html_url: 'https://github.com/zerodha-clone/pushed-today',
            description: null,
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: 'Python',
            topics: [],
            created_at: threeYearsAgo.toISOString(),
            pushed_at: today.toISOString(),
            owner: { login: 'zerodha-clone' },
            name: 'pushed-today',
          },
          {
            id: 202,
            full_name: 'zerodha-clone/stale-since-2023',
            html_url: 'https://github.com/zerodha-clone/stale-since-2023',
            description: null,
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: 'Python',
            topics: [],
            created_at: threeYearsAgo.toISOString(),
            pushed_at: threeYearsAgo.toISOString(),
            owner: { login: 'zerodha-clone' },
            name: 'stale-since-2023',
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
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    // "Only today's activity" - createdFrom/createdTo/pushedFrom/pushedTo
    // all pinned to today, dateFilterMode 'or' - exactly what the New Scan
    // form's todayOnly toggle sends.
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              reposDiscovered: 0,
              createdFrom: today,
              createdTo: today,
              pushedFrom: today,
              pushedTo: today,
              dateFilterMode: 'or',
            }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: '"zerodha" (AKIA OR ghp_)',
        queryIndex: 0,
        maxRepos: 25,
        searchKind: 'code',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    // Only the repo pushed today should ever reach claim/dedup/enqueue -
    // the 3-year-stale one must be dropped before claimRepositoryForAnalysis,
    // exactly as if it never matched the code search query at all.
    expect(incremental.claimRepositoryForAnalysis).toHaveBeenCalledTimes(1);
    expect(incremental.claimRepositoryForAnalysis).toHaveBeenCalledWith(
      scanJobId,
      201,
      25,
    );
    expect(scanQueue.enqueueRepositoryAnalysis).toHaveBeenCalledTimes(1);
    const [analysisPayload] = scanQueue.enqueueRepositoryAnalysis.mock
      .calls[0] as [{ repo: { id: number } }];
    expect(analysisPayload.repo.id).toBe(201);
  });

  it('does not apply the client-side date filter to repository-search results (the query string already enforces it via created:/pushed:)', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = { matchBrand: jest.fn() };
    const today = new Date();
    const threeYearsAgo = new Date(
      today.getFullYear() - 3,
      today.getMonth(),
      today.getDate(),
    );
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 301,
            full_name: 'zerodha-clone/old-repo-matched-by-name',
            html_url: 'https://github.com/zerodha-clone/old-repo-matched-by-name',
            description: null,
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: 'Python',
            topics: [],
            created_at: threeYearsAgo.toISOString(),
            pushed_at: threeYearsAgo.toISOString(),
            owner: { login: 'zerodha-clone' },
            name: 'old-repo-matched-by-name',
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
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              reposDiscovered: 0,
              createdFrom: today,
              createdTo: today,
              pushedFrom: today,
              pushedTo: today,
              dateFilterMode: 'or',
            }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'zerodha (login OR otp) in:name,description created:2026-08-10..2026-08-10',
        queryIndex: 0,
        maxRepos: 25,
        searchKind: 'repositories',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    // Repository search already enforced the date range via the created:
    // qualifier baked into the query string itself - GitHub wouldn't have
    // returned this item at all if it didn't match, so the client-side
    // filter must not re-check (and potentially wrongly drop) it here.
    expect(incremental.claimRepositoryForAnalysis).toHaveBeenCalledTimes(1);
    expect(scanQueue.enqueueRepositoryAnalysis).toHaveBeenCalledTimes(1);
  });

  it('discoveryOnly: saves discovered repo metadata but never enqueues content analysis', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      matchBrand: jest.fn(),
      upsertRepository: jest.fn().mockResolvedValue({}),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 401,
            full_name: 'evil/zerodha-clone',
            html_url: 'https://github.com/evil/zerodha-clone',
            description: null,
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: null,
            topics: [],
            created_at: '2026-08-10T00:00:00Z',
            pushed_at: '2026-08-10T00:00:00Z',
            owner: { login: 'evil' },
            name: 'zerodha-clone',
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
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'zerodha apk in:name,description',
        queryIndex: 0,
        maxRepos: 25,
        discoveryOnly: true,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(pipeline.upsertRepository).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ id: 401 }),
      expect.objectContaining({
        scanJobId,
        discoveredOnly: true,
        internalAudit: false,
      }),
    );
    // The whole point of discoveryOnly - no clone, no file fetch, no
    // detection, no finding. It should behave exactly like a claim that
    // was recorded and then stopped, not sent onward for analysis.
    expect(scanQueue.enqueueRepositoryAnalysis).not.toHaveBeenCalled();
    expect(scanState.recordRepositoryDiscovered).toHaveBeenCalledWith(
      scanJobId,
      { countsTowardAnalysis: false },
    );
  });

  it('discoveryOnly + code search: captures the matched file path as discovery evidence, no extra GitHub call', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      matchBrand: jest.fn(),
      upsertRepository: jest.fn().mockResolvedValue({}),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchCode: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 402,
            full_name: 'Vineetok/fintech_prim',
            html_url: 'https://github.com/Vineetok/fintech_prim',
            description: null,
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: 'TypeScript',
            topics: [],
            created_at: '2026-08-10T00:00:00Z',
            pushed_at: '2026-08-10T00:00:00Z',
            owner: { login: 'Vineetok' },
            name: 'fintech_prim',
            matchedPath: 'web-frontend-main/app/products/mutual-funds/components/TopPicks.ts',
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
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({ reposDiscovered: 0, scopeKeyword: 'motilal-oswal' }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: '"motilal-oswal"',
        queryIndex: 0,
        maxRepos: 25,
        discoveryOnly: true,
        searchKind: 'code',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(pipeline.upsertRepository).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ id: 402 }),
      expect.objectContaining({
        scanJobId,
        discoveredOnly: true,
        discoveryMatchedField: 'file_content',
        discoveryMatchedPath:
          'web-frontend-main/app/products/mutual-funds/components/TopPicks.ts',
      }),
    );
  });

  it('discoveryOnly + repo search: captures which metadata field (description) contains the scoped keyword', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      matchBrand: jest.fn(),
      upsertRepository: jest.fn().mockResolvedValue({}),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 403,
            full_name: 'someone/wallet-app',
            html_url: 'https://github.com/someone/wallet-app',
            description: 'Investment tracker mentioning Motilal Oswal funds',
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: null,
            topics: [],
            created_at: '2026-08-10T00:00:00Z',
            pushed_at: '2026-08-10T00:00:00Z',
            owner: { login: 'someone' },
            name: 'wallet-app',
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
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scopeBrandId = 'brand-motilal-oswal';
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              reposDiscovered: 0,
              scopeKeyword: 'Motilal Oswal',
              scopeBrandId,
            }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'motilal oswal "Motilal Oswal" in:name,description',
        queryIndex: 0,
        maxRepos: 25,
        discoveryOnly: true,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(pipeline.upsertRepository).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ id: 403 }),
      expect.objectContaining({
        scanJobId,
        discoveredOnly: true,
        discoveryMatchedField: 'description',
        discoveryMatchedText: 'Investment tracker mentioning Motilal Oswal funds',
        discoveryBrandId: scopeBrandId,
        discoveryKeyword: 'Motilal Oswal',
      }),
    );
  });

  it('discoveryOnly: carries the flag forward to the next page when a query has more results - regression for page 2+ silently dropping back into full content analysis', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      matchBrand: jest.fn(),
      upsertRepository: jest.fn().mockResolvedValue({}),
    };
    const makeItem = (id: number) => ({
      id,
      full_name: `evil/repo-${id}`,
      html_url: `https://github.com/evil/repo-${id}`,
      description: null,
      stargazers_count: 0,
      forks_count: 0,
      fork: false,
      language: null,
      topics: [],
      created_at: '2026-08-10T00:00:00Z',
      pushed_at: '2026-08-10T00:00:00Z',
      owner: { login: 'evil' },
      name: `repo-${id}`,
    });
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      // 5 items === batchSize (see config below) and total_count > page *
      // batchSize - both required for hasMoreResults to come out true.
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 50,
        incomplete_results: false,
        items: [1, 2, 3, 4, 5].map(makeItem),
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '5' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'zerodha apk in:name,description',
        queryIndex: 0,
        maxRepos: 1000,
        page: 1,
        discoveryOnly: true,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, discoveryOnly: true }),
      expect.anything(),
    );
  });

  it("discoveryOnly: skips a repo already known workspace-wide (found by another scan, e.g. a concurrent keyword toggle) without claiming, upserting, or counting it", async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      matchBrand: jest.fn(),
      upsertRepository: jest.fn().mockResolvedValue({}),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 402,
            full_name: 'evil/already-known',
            html_url: 'https://github.com/evil/already-known',
            description: null,
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: null,
            topics: [],
            created_at: '2026-08-10T00:00:00Z',
            pushed_at: '2026-08-10T00:00:00Z',
            owner: { login: 'evil' },
            name: 'already-known',
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
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      // Already recorded by another scan (e.g. a different keyword's
      // concurrently-running toggle for the same brand).
      findByGithubId: jest.fn().mockResolvedValue({ githubId: 402 }),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'zerodha "otp" in:name,description',
        queryIndex: 0,
        maxRepos: 25,
        discoveryOnly: true,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(incremental.findByGithubId).toHaveBeenCalledWith(workspaceId, 402);
    expect(incremental.claimRepositoryForAnalysis).not.toHaveBeenCalled();
    expect(pipeline.upsertRepository).not.toHaveBeenCalled();
    expect(scanState.recordRepositoryDiscovered).not.toHaveBeenCalled();
  });

  it("discoveryOnly: a repo already known to a DIFFERENT brand still gets this scan's own brand recorded as an additional match, instead of silently vanishing for it", async () => {
    const growwBrandId = new Types.ObjectId();
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      matchBrand: jest.fn(),
      upsertRepository: jest.fn().mockResolvedValue({}),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 402,
            full_name: 'divgandhi179-pixel/Broker-aggregator',
            html_url: 'https://github.com/divgandhi179-pixel/Broker-aggregator',
            description: 'mentions groww and motilal oswal',
            stargazers_count: 0,
            forks_count: 0,
            fork: false,
            language: null,
            topics: [],
            created_at: '2026-08-10T00:00:00Z',
            pushed_at: '2026-08-10T00:00:00Z',
            owner: { login: 'divgandhi179-pixel' },
            name: 'Broker-aggregator',
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
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () =>
          ({
            exec: () =>
              Promise.resolve({
                reposDiscovered: 0,
                scopeBrandId: growwBrandId,
                scopeKeyword: 'groww',
              }),
          }) as never,
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      // Already recorded, but by a DIFFERENT brand's scan (Motilal
      // Oswal's own earlier discovery of this repo, say).
      findByGithubId: jest.fn().mockResolvedValue({ githubId: 402 }),
      recordAdditionalBrandMatch: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'groww in:name,description',
        queryIndex: 0,
        maxRepos: 25,
        discoveryOnly: true,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(incremental.recordAdditionalBrandMatch).toHaveBeenCalledWith(
      workspaceId,
      402,
      expect.objectContaining({
        brandId: String(growwBrandId),
        keyword: 'groww',
        matchedField: 'description',
      }),
    );
    // The repo itself still isn't re-claimed, re-upserted, or re-counted -
    // only the cross-brand fact is recorded.
    expect(incremental.claimRepositoryForAnalysis).not.toHaveBeenCalled();
    expect(pipeline.upsertRepository).not.toHaveBeenCalled();
    expect(scanState.recordRepositoryDiscovered).not.toHaveBeenCalled();
  });

  it('only passes the scoped brand through when the scan is scoped to one brand (not every enabled brand)', async () => {
    const angelOneId = new Types.ObjectId();
    const growwId = new Types.ObjectId();
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 555,
            full_name: 'someone/angleone-trading-tool',
            html_url: 'https://github.com/someone/angleone-trading-tool',
            description: 'A trading utility',
            stargazers_count: 3,
            forks_count: 0,
            fork: false,
            language: 'Python',
            topics: [],
            created_at: '2024-01-01T00:00:00Z',
            pushed_at: '2024-01-02T00:00:00Z',
            owner: { login: 'someone' },
            name: 'angleone-trading-tool',
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
              { _id: angelOneId, name: 'Angel One', aliases: ['angelone'] },
              { _id: growwId, name: 'Groww', aliases: ['groww'] },
            ]),
        }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              reposDiscovered: 0,
              scopeBrandId: angelOneId,
            }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
      findByGithubId: jest.fn().mockResolvedValue(null),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'angelone',
        queryIndex: 0,
        maxRepos: 25,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    const [analysisPayload] = scanQueue.enqueueRepositoryAnalysis.mock
      .calls[0] as [{ brands: Array<{ id: string; name: string }> }];
    expect(analysisPayload.brands).toHaveLength(1);
    expect(analysisPayload.brands[0].name).toBe('Angel One');
  });

  it('skips live work when scan is cancelled', async () => {
    const scanQueue = { enqueueRepositoryAnalysis: jest.fn() };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(true),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
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
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
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
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
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
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
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
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
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
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
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

  it('completes cleanly without retrying when a cancelled scan aborts mid-request, instead of treating it as a failure', async () => {
    const scanQueue = { enqueueRepositoryAnalysis: jest.fn() };
    // First call (pre-check) says "not cancelled" so the job actually starts
    // work; the catch-block check says "cancelled" - simulating the scan
    // being cancelled while the GitHub request/wait was in flight.
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      searchRepositories: jest
        .fn()
        .mockRejectedValue(new Error('Request cancelled')),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '5' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      { matchBrand: jest.fn() } as never,
      incremental as never,
      { saveCursor: jest.fn().mockResolvedValue(undefined) } as never,
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

    // No throw (BullMQ would otherwise retry with backoff) and no
    // repositories enqueued from a request that never actually completed.
    expect(scanState.completeSearchJob).toHaveBeenCalledWith(scanJobId, 0);
    expect(scanQueue.enqueueRepositoryAnalysis).not.toHaveBeenCalled();
  });

  it('persists a durable cursor marked NOT exhausted when GitHub has more pages for this query', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: 200 + i,
      full_name: `evil/clone-${i}`,
      html_url: `https://github.com/evil/clone-${i}`,
      description: '',
      stargazers_count: 0,
      forks_count: 0,
      fork: false,
      language: 'JavaScript',
      topics: [],
      created_at: '2024-01-01T00:00:00Z',
      pushed_at: '2024-01-02T00:00:00Z',
      owner: { login: 'evil' },
      name: `clone-${i}`,
    }));
    const github = {
      // total_count large enough that page 1 of 5 items leaves more results
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 50,
        incomplete_results: false,
        items,
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '5' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };
    const discoveryCursor = {
      saveCursor: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      discoveryCursor as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: '"zerodha" login verify',
        queryIndex: 0,
        maxRepos: 1000,
        page: 1,
        searchKind: 'repositories',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      '"zerodha" login verify',
      1,
      false,
    );
  });

  it('persists a durable cursor marked exhausted when GitHub returns a short/final page for this query', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      // Fewer items than batchSize - GitHub has nothing more for this query.
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 2,
        incomplete_results: false,
        items: [],
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '5' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };
    const discoveryCursor = {
      saveCursor: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      discoveryCursor as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: '"zerodha" login verify',
        queryIndex: 0,
        maxRepos: 1000,
        page: 3,
        searchKind: 'repositories',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      '"zerodha" login verify',
      3,
      true,
    );
  });

  it('never calls GitHub for a page beyond its 1000-result cap (422 territory) - marks the durable cursor exhausted instead (regression: a continueDiscovery cursor that reached the cap must reset, not 422 forever)', async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      searchRepositories: jest.fn(),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '100' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };
    const discoveryCursor = {
      saveCursor: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      discoveryCursor as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    // batchSize=100, page=11 -> (11-1)*100 = 1000 >= GitHub's 1000-result cap.
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: '"zerodha" login verify',
        queryIndex: 0,
        maxRepos: 1000,
        page: 11,
        searchKind: 'repositories',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(github.searchRepositories).not.toHaveBeenCalled();
    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      '"zerodha" login verify',
      11,
      true,
    );
    expect(scanState.completeSearchJob).toHaveBeenCalledWith(scanJobId, 0);
  });

  it("treats the query as exhausted right at the 1000-result boundary even when GitHub's own total_count overclaims further results", async () => {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: 300 + i,
      full_name: `evil/clone-${i}`,
      html_url: `https://github.com/evil/clone-${i}`,
      description: '',
      stargazers_count: 0,
      forks_count: 0,
      fork: false,
      language: 'JavaScript',
      topics: [],
      created_at: '2024-01-01T00:00:00Z',
      pushed_at: '2024-01-02T00:00:00Z',
      owner: { login: 'evil' },
      name: `clone-${i}`,
    }));
    const github = {
      // GitHub's own reported total (5000) claims far more results exist
      // beyond page 10 - none of them are actually fetchable.
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: 5000,
        incomplete_results: false,
        items,
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '100' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ reposDiscovered: 0 }) }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };
    const discoveryCursor = {
      saveCursor: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      discoveryCursor as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );

    // page 10 * batchSize 100 = 1000, exactly GitHub's ceiling.
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: '"zerodha" login verify',
        queryIndex: 0,
        maxRepos: 100000,
        page: 10,
        searchKind: 'repositories',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      '"zerodha" login verify',
      10,
      true,
    );
    // Must not try to enqueue an impossible page 11.
    expect(scanQueue.enqueueGithubSearch).not.toHaveBeenCalled();
  });
});

describe('GitHubSearchProcessor oversized code-search query splitting', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();

  function buildProcessor(
    totalCount: number,
    scanOverrides: Record<string, unknown> = {},
  ) {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      searchCode: jest.fn().mockResolvedValue({
        total_count: totalCount,
        incomplete_results: false,
        items: [],
      }),
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: totalCount,
        incomplete_results: false,
        items: [],
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '100' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () => Promise.resolve({ reposDiscovered: 0, ...scanOverrides }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };
    const discoveryCursor = {
      saveCursor: jest.fn().mockResolvedValue(undefined),
      getResumePage: jest.fn().mockResolvedValue(1),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      discoveryCursor as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );
    return { processor, scanQueue, discoveryCursor };
  }

  it('splits into per-language queries when a page-1 secret-filename code query is near the 1000 cap', async () => {
    const { processor, scanQueue } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'filename:.env AKIA',
        queryIndex: 3,
        maxRepos: 1000,
        page: 1,
        searchKind: 'code',
        family: 'secret-filename',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    const splitCalls = scanQueue.enqueueGithubSearch.mock.calls.filter(
      (call) =>
        (call[0] as { family: string }).family === 'secret-filename-split',
    );
    // +1: one query per configured language, plus the trailing catch-all
    // for files GitHub never classified into any of them.
    expect(splitCalls).toHaveLength(CODE_SEARCH_SPLIT_LANGUAGES.length + 1);
    const queries = splitCalls.map(
      (call) => (call[0] as { query: string }).query,
    );
    expect(queries.slice(0, CODE_SEARCH_SPLIT_LANGUAGES.length)).toEqual(
      CODE_SEARCH_SPLIT_LANGUAGES.map(
        (lang) => `filename:.env AKIA language:${lang}`,
      ),
    );
    expect(queries[queries.length - 1]).toBe(
      'filename:.env AKIA ' +
        CODE_SEARCH_SPLIT_LANGUAGES.map((lang) => `-language:${lang}`).join(
          ' ',
        ),
    );
    // Synthetic indices must never collide with the real 0..N-1 querySpecs range.
    const indices = splitCalls.map(
      (call) => (call[0] as { queryIndex: number }).queryIndex,
    );
    expect(indices.every((idx) => idx >= 100_000)).toBe(true);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('resumes each language-split child from its own durable cursor when the scan has continueDiscovery on, instead of always restarting every one at page 1', async () => {
    const { processor, scanQueue, discoveryCursor } = buildProcessor(950, {
      continueDiscovery: true,
    });
    discoveryCursor.getResumePage = jest
      .fn()
      .mockImplementation((_ws: string, kind: string, query: string) =>
        Promise.resolve(
          kind === 'code' && query.endsWith('language:JavaScript') ? 4 : 1,
        ),
      );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'filename:.env AKIA',
        queryIndex: 3,
        maxRepos: 1000,
        page: 1,
        searchKind: 'code',
        family: 'secret-filename',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    const splitCalls = scanQueue.enqueueGithubSearch.mock.calls.filter(
      (call) =>
        (call[0] as { family: string }).family === 'secret-filename-split',
    );
    const jsCall = splitCalls.find((call) =>
      (call[0] as { query: string }).query.endsWith('language:JavaScript'),
    );
    const otherCall = splitCalls.find(
      (call) =>
        !(call[0] as { query: string }).query.endsWith('language:JavaScript'),
    );
    expect((jsCall![0] as { page: number }).page).toBe(4);
    expect((otherCall![0] as { page: number }).page).toBe(1);
  });

  it('splits a brand-scoped code query too (not just secret-filename)', async () => {
    // Regression: this used to be restricted to the secret-filename family
    // only, so a brand-scoped code query (brand-secret,
    // brand-keyword-custom-code, distinctive-content) that happened to hit
    // a common term would just hard-cap at page 10 with no relief at all.
    const { processor, scanQueue } = buildProcessor(5000);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: '"zerodha" (AKIA OR ghp_)',
        queryIndex: 1,
        maxRepos: 1000,
        page: 1,
        searchKind: 'code',
        family: 'brand-secret',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    const splitCalls = scanQueue.enqueueGithubSearch.mock.calls.filter(
      (call) => (call[0] as { family: string }).family === 'brand-secret-split',
    );
    expect(splitCalls).toHaveLength(CODE_SEARCH_SPLIT_LANGUAGES.length + 1);
  });

  it('does not split when total_count is comfortably under the threshold', async () => {
    const { processor, scanQueue } = buildProcessor(50);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'filename:credentials.json',
        queryIndex: 2,
        maxRepos: 1000,
        page: 1,
        searchKind: 'code',
        family: 'secret-filename',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).not.toHaveBeenCalled();
  });

  it('does not re-split an already-split query by LANGUAGE again (bounded to one level for that dimension) - but does bisect it by file size instead, since a language bucket can itself still be oversized', async () => {
    const { processor, scanQueue } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'filename:.env AKIA language:Python',
        queryIndex: 100_003,
        maxRepos: 1000,
        page: 1,
        searchKind: 'code',
        family: 'secret-filename-split',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(2);
    const calls = scanQueue.enqueueGithubSearch.mock.calls.map(
      (call) =>
        call[0] as { query: string; family: string; sizeSplitDepth: number },
    );
    // Never a second language: qualifier appended - only ever one size: split.
    for (const call of calls) {
      expect(call.query).toMatch(
        /^filename:\.env AKIA language:Python size:\d+\.\.\d+$/,
      );
      expect(call.family).toBe('secret-filename-split');
      expect(call.sizeSplitDepth).toBe(1);
    }
  });

  it('does not split on a later page, even if the query is oversized (decide once, on page 1 only)', async () => {
    const { processor, scanQueue } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'filename:.env AKIA',
        queryIndex: 3,
        maxRepos: 1000,
        page: 2,
        searchKind: 'code',
        family: 'secret-filename',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).not.toHaveBeenCalled();
  });

  it('does not apply the code-search language split to a repository-search query, even one flagged secret-filename', async () => {
    // The repository-search query below is still eligible for the
    // *separate* date-range split (covered in its own describe block below)
    // now that unbounded/no-date queries qualify too - so this asserts
    // specifically that no language:-tagged (code-split) query was
    // enqueued, not that nothing was enqueued at all.
    const { processor, scanQueue } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'dotenv OR credentials in:name,description',
        queryIndex: 3,
        maxRepos: 1000,
        page: 1,
        searchKind: 'repositories',
        family: 'secret-filename',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    const languageSplitCalls = scanQueue.enqueueGithubSearch.mock.calls.filter(
      (call) => (call[0] as { query: string }).query.includes('language:'),
    );
    expect(languageSplitCalls).toHaveLength(0);
  });
});

describe('GitHubSearchProcessor oversized date-range query splitting', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();

  function buildProcessor(
    totalCount: number,
    itemCount = 0,
    scanOverrides: Record<string, unknown> = {},
  ) {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      completeSearchJob: jest.fn().mockResolvedValue(undefined),
      recordRepositoryDiscovered: jest.fn().mockResolvedValue(undefined),
    };
    const items = Array.from({ length: itemCount }, (_, i) => ({
      id: 400 + i,
      full_name: `evil/clone-${i}`,
      html_url: `https://github.com/evil/clone-${i}`,
      description: '',
      stargazers_count: 0,
      forks_count: 0,
      fork: false,
      language: 'JavaScript',
      topics: [],
      created_at: '2026-08-07T00:00:00Z',
      pushed_at: '2026-08-07T00:00:00Z',
      owner: { login: 'evil' },
      name: `clone-${i}`,
    }));
    const github = {
      searchRepositories: jest.fn().mockResolvedValue({
        total_count: totalCount,
        incomplete_results: false,
        items,
      }),
      searchCode: jest.fn().mockResolvedValue({
        total_count: totalCount,
        incomplete_results: false,
        items: [],
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: (key: string) => (key === 'SEARCH_BATCH_SIZE' ? '100' : '120000'),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () => Promise.resolve({ reposDiscovered: 0, ...scanOverrides }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
      saveCheckpoint: jest.fn().mockResolvedValue({}),
    };
    const discoveryCursor = {
      saveCursor: jest.fn().mockResolvedValue(undefined),
      getResumePage: jest.fn().mockResolvedValue(1),
    };

    const processor = new GitHubSearchProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      discoveryCursor as never,
      github as never,
      config as never,
      brandModel as never,
      scanModel as never,
    );
    return { processor, scanQueue, discoveryCursor };
  }

  it('bisects a brand-scoped repo query with a bounded date range when near the 1000 cap', async () => {
    const { processor, scanQueue, discoveryCursor } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query:
          'zerodha (login OR otp) in:name,description created:2026-08-07..2026-08-07',
        queryIndex: 4,
        maxRepos: 1000,
        page: 1,
        searchKind: 'repositories',
        family: 'phishing',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(2);
    const queries = scanQueue.enqueueGithubSearch.mock.calls.map(
      (call) => (call[0] as { query: string; family: string }).query,
    );
    queries.forEach((q) => expect(q).toContain('zerodha (login OR otp)'));
    // Two distinct, non-colliding synthetic indices, both clear of the real range.
    const indices = scanQueue.enqueueGithubSearch.mock.calls.map(
      (call) => (call[0] as { queryIndex: number }).queryIndex,
    );
    expect(new Set(indices).size).toBe(2);
    expect(indices.every((idx) => idx >= 200_000)).toBe(true);

    // The original (now-superseded) query's own cursor is marked exhausted -
    // its coverage now belongs to the two halves, not further pages of itself.
    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      'zerodha (login OR otp) in:name,description created:2026-08-07..2026-08-07',
      1,
      true,
    );
  });

  it("resumes a split child from its OWN durable cursor when the scan has continueDiscovery on, instead of always restarting it at page 1 (regression: a popular keyword almost always exceeds the split threshold, so nearly all its real pagination progress lives in split children - hardcoding page 1 there made 'Resume from last' a no-op for exactly the queries that matter)", async () => {
    // scan.continueDiscovery: true - the toggle this test proves actually
    // reaches split children, not just the top-level per-scan dispatch.
    const { processor, scanQueue, discoveryCursor } = buildProcessor(950, 0, {
      continueDiscovery: true,
    });
    // One half already has real progress from an earlier turn (lastPage 9,
    // not exhausted); the other has never been seen before. The first half
    // of a 2008-01-01..2099-12-31 bisection always starts at 2008-01-01
    // itself, so that literal substring reliably distinguishes it.
    discoveryCursor.getResumePage = jest
      .fn()
      .mockImplementation((_ws: string, _kind: string, query: string) =>
        Promise.resolve(query.includes('2008-01-01') ? 10 : 1),
      );

    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'zerodha created:2008-01-01..2099-12-31',
        queryIndex: 0,
        maxRepos: 1000,
        page: 1,
        searchKind: 'repositories',
        family: 'brand-keyword-custom',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(2);
    const pages = scanQueue.enqueueGithubSearch.mock.calls.map(
      (call) => (call[0] as { query: string; page: number }).page,
    );
    // Neither child was hardcoded to 1 - one resumed at page 10, the other
    // (genuinely never seen before) correctly started fresh at page 1.
    expect(pages.sort()).toEqual([1, 10]);
  });

  it('splits a repo query with no created: date range at all, by synthesizing a full bounded range first', async () => {
    // Regression: this used to fall back to the plain exhausted/reset-to-1
    // behavior since splitCreatedRangeQuery has nothing to bisect without an
    // existing created:X..Y range - silently capping forever at the same
    // top 1000 most-recently-updated results. ensureBoundedCreatedRange now
    // gives it one (EARLIEST_SANE_DATE..FAR_FUTURE_DATE, a fixed ceiling -
    // not "today", so the split boundary is stable across days - see
    // query-families.ts) so it gets the same relief a date-scoped scan
    // already had.
    const { processor, scanQueue, discoveryCursor } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'zerodha (login OR otp) in:name,description',
        queryIndex: 4,
        maxRepos: 1000,
        page: 1,
        searchKind: 'repositories',
        family: 'phishing',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(2);
    const queries = scanQueue.enqueueGithubSearch.mock.calls.map(
      (call) => (call[0] as { query: string }).query,
    );
    queries.forEach((q) => {
      expect(q).toContain('zerodha (login OR otp) in:name,description created:');
    });

    // The original (now-superseded) query's own cursor is still the one
    // marked exhausted - its coverage now belongs to the two synthesized
    // halves, not further pages of itself.
    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      'zerodha (login OR otp) in:name,description',
      1,
      true,
    );
  });

  it('tags each split half with an incremented splitDepth', async () => {
    const { processor, scanQueue } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query:
          'zerodha (login OR otp) in:name,description created:2026-01-01..2026-06-30',
        queryIndex: 4,
        maxRepos: 1000,
        page: 1,
        searchKind: 'repositories',
        family: 'phishing',
        splitDepth: 2,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(2);
    const depths = scanQueue.enqueueGithubSearch.mock.calls.map(
      (call) => (call[0] as { splitDepth: number }).splitDepth,
    );
    expect(depths).toEqual([3, 3]);
  });

  it('stops recursing once MAX_DATE_SPLIT_DEPTH is reached, regardless of total_count (regression: unbounded fan-out made scans appear stuck)', async () => {
    // A pathological brand-agnostic query with a huge total_count and no
    // real narrowing - before the depth cap, this could recurse dozens of
    // levels deep, each level doubling the number of real GitHub requests
    // still owed. None of that shows up as a rate-limit failure (quota is
    // never actually exhausted - the requests just serialize against the
    // 30/min budget for a very long time), which is exactly why it read as
    // "stuck" with no limit-hit message anywhere in the logs.
    const { processor, scanQueue, discoveryCursor } = buildProcessor(50000);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'aws (login OR apk OR phishing) in:name,description',
        queryIndex: 4,
        maxRepos: 1000,
        page: 1,
        searchKind: 'repositories',
        family: 'brand-keyword',
        splitDepth: 10,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).not.toHaveBeenCalled();
    // Falls back to the plain exhausted/reset-to-page-1 behavior instead.
    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      'aws (login OR apk OR phishing) in:name,description',
      1,
      expect.any(Boolean),
    );
  });

  it('stops recursing the size-split once MAX_SIZE_SPLIT_DEPTH is reached, regardless of total_count (same fan-out protection as the date-split cap, for code search)', async () => {
    const { processor, scanQueue, discoveryCursor } = buildProcessor(50000);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'filename:.env AKIA language:Python size:0..1000000',
        queryIndex: 4,
        maxRepos: 1000,
        page: 1,
        searchKind: 'code',
        family: 'secret-filename-split',
        sizeSplitDepth: 7,
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).not.toHaveBeenCalled();
    expect(discoveryCursor.saveCursor).toHaveBeenCalledWith(
      workspaceId,
      'code',
      'filename:.env AKIA language:Python size:0..1000000',
      1,
      expect.any(Boolean),
    );
  });

  it('does not split a code-search query (created: splitting only applies to repository search)', async () => {
    const { processor, scanQueue } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query: 'filename:.env AKIA',
        queryIndex: 4,
        maxRepos: 1000,
        page: 1,
        searchKind: 'code',
        family: 'secret-filename',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    // The code-search language split IS expected here (different mechanism) -
    // assert specifically that no date-range split occurred alongside it.
    const dateSplitCalls = scanQueue.enqueueGithubSearch.mock.calls.filter(
      (call) => (call[0] as { query: string }).query.includes('created:'),
    );
    expect(dateSplitCalls).toHaveLength(0);
  });

  it('does not split on a later page, even if the query is oversized (decide once, on page 1 only)', async () => {
    const { processor, scanQueue } = buildProcessor(950);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query:
          'zerodha (login OR otp) in:name,description created:2026-08-07..2026-08-07',
        queryIndex: 4,
        maxRepos: 1000,
        page: 2,
        searchKind: 'repositories',
        family: 'phishing',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    expect(scanQueue.enqueueGithubSearch).not.toHaveBeenCalled();
  });

  it('does not enqueue a redundant "next page" of the original query once it has been split (no overlapping coverage)', async () => {
    // items.length === batchSize (100) would normally trigger the plain
    // pagination continuation too - confirm the split suppresses it.
    const { processor, scanQueue } = buildProcessor(950, 100);
    await processor.process({
      data: {
        workspaceId,
        scanJobId,
        query:
          'zerodha (login OR otp) in:name,description created:2026-08-07..2026-08-07',
        queryIndex: 4,
        maxRepos: 100000,
        page: 1,
        searchKind: 'repositories',
        family: 'phishing',
      },
      opts: { priority: 5, attempts: 3 },
      attemptsMade: 0,
    } as never);

    // Exactly the 2 split halves - no 3rd "page 2 of the original" call.
    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(2);
    const originalPage2 = scanQueue.enqueueGithubSearch.mock.calls.some(
      (call) =>
        (call[0] as { query: string }).query ===
        'zerodha (login OR otp) in:name,description created:2026-08-07..2026-08-07',
    );
    expect(originalPage2).toBe(false);
  });
});
