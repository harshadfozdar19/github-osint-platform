import { Types } from 'mongoose';
import { ScanOrchestratorProcessor } from './scan-orchestrator.processor';

describe('ScanOrchestratorProcessor distinctive-phrase wiring', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();
  const brandId = new Types.ObjectId();

  function buildProcessor(
    phraseRows: Array<{ brandId: unknown; text: string }>,
  ) {
    const scanQueue = {
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({
        mode: 'incremental',
        maxRepos: 1000,
        checkpoint: {},
      }),
      isCancelled: jest.fn().mockResolvedValue(false),
      markRunning: jest.fn().mockResolvedValue(undefined),
      setQueries: jest.fn().mockResolvedValue(undefined),
      markCompletedEarly: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isConfiguredForWorkspace: jest.fn().mockResolvedValue(true),
      isRateLimited: jest.fn().mockResolvedValue(false),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      saveCheckpoint: jest.fn().mockResolvedValue(undefined),
      listFailedGithubIds: jest.fn().mockResolvedValue([]),
    };
    const pipeline = {
      buildSearchQueries: jest
        .fn()
        .mockReturnValue([
          { kind: 'code', family: 'distinctive-content', query: '"bait"' },
        ]),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve([
              {
                _id: brandId,
                name: 'Acme',
                aliases: ['acme'],
                trustedGithubOwners: [],
              },
            ]),
        }),
      }),
    };
    const keywordModel = {
      find: jest
        .fn()
        .mockReturnValue({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
    };
    const scanModel = { findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
    const contentStringModel = {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve(phraseRows),
      }),
    };

    const processor = new ScanOrchestratorProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { getResumePage: jest.fn().mockResolvedValue(1) } as never,
      github as never,
      { get: () => undefined } as never,
      brandModel as never,
      keywordModel as never,
      scanModel as never,
      contentStringModel as never,
    );

    return { processor, pipeline, contentStringModel, scanState };
  }

  it("fetches and attaches each brand's top distinctive phrases before building search queries", async () => {
    const { processor, pipeline, contentStringModel } = buildProcessor([
      { brandId, text: 'Track your shipment with Acme Express nationwide' },
      {
        brandId,
        text: 'Nationwide logistics for e-commerce sellers everywhere',
      },
    ]);

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(contentStringModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ brandId: { $in: [brandId] } }),
    );
    expect(pipeline.buildSearchQueries).toHaveBeenCalled();
    const [brandsArg] = pipeline.buildSearchQueries.mock.calls[0] as [
      Array<{ distinctivePhrases: string[] }>,
    ];
    expect(brandsArg[0].distinctivePhrases).toEqual([
      'Track your shipment with Acme Express nationwide',
      'Nationwide logistics for e-commerce sellers everywhere',
    ]);
  });

  it('attaches an empty phrase list when no distinctive content has been ingested for the brand', async () => {
    const { processor, pipeline } = buildProcessor([]);

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    const [brandsArg] = pipeline.buildSearchQueries.mock.calls[0] as [
      Array<{ distinctivePhrases: string[] }>,
    ];
    expect(brandsArg[0].distinctivePhrases).toEqual([]);
  });

  it('passes scopedToBrand=true to buildSearchQueries when the scan has a scopeBrandId (regression: brand-agnostic sweeps leaking into a brand-scoped scan)', async () => {
    const { processor, pipeline, scanState } = buildProcessor([]);
    scanState.assertOwned.mockResolvedValue({
      mode: 'incremental',
      maxRepos: 1000,
      checkpoint: {},
      scopeBrandId: brandId,
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    const call = pipeline.buildSearchQueries.mock.calls[0];
    expect(call[3]).toBe(true);
  });

  it('passes scopedToBrand=false to buildSearchQueries for an unscoped, all-brands scan', async () => {
    const { processor, pipeline } = buildProcessor([]);

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    const call = pipeline.buildSearchQueries.mock.calls[0];
    expect(call[3]).toBe(false);
  });

  it('passes scan.scopeKeyword through to buildSearchQueries as the onlyKeyword arg', async () => {
    const { processor, pipeline, scanState } = buildProcessor([]);
    scanState.assertOwned.mockResolvedValue({
      mode: 'incremental',
      maxRepos: 1000,
      checkpoint: {},
      scopeBrandId: brandId,
      scopeKeyword: 'otp bypass',
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    const call = pipeline.buildSearchQueries.mock.calls[0];
    expect(call[4]).toBe('otp bypass');
  });
});

describe('ScanOrchestratorProcessor custom-query date filtering', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();

  function buildProcessor(scanOverrides: Record<string, unknown>) {
    const scanQueue = {
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({
        mode: 'incremental',
        maxRepos: 1000,
        checkpoint: {},
        scopeQuery: 'angelone login',
        scopeSearchKind: 'repositories',
        ...scanOverrides,
      }),
      isCancelled: jest.fn().mockResolvedValue(false),
      markRunning: jest.fn().mockResolvedValue(undefined),
      setQueries: jest.fn().mockResolvedValue(undefined),
      markCompletedEarly: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isConfiguredForWorkspace: jest.fn().mockResolvedValue(true),
      isRateLimited: jest.fn().mockResolvedValue(false),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      saveCheckpoint: jest.fn().mockResolvedValue(undefined),
      listFailedGithubIds: jest.fn().mockResolvedValue([]),
    };
    const pipeline = { buildSearchQueries: jest.fn() };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const keywordModel = {
      find: jest
        .fn()
        .mockReturnValue({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
    };
    const scanModel = { findByIdAndUpdate: jest.fn().mockResolvedValue({}) };

    const processor = new ScanOrchestratorProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      { getResumePage: jest.fn().mockResolvedValue(1) } as never,
      github as never,
      { get: () => undefined } as never,
      brandModel as never,
      keywordModel as never,
      scanModel as never,
    );

    return { processor, scanQueue, scanState };
  }

  it("issues two search jobs - one created-only, one pushed-only - for a customQuery scan with dateFilterMode 'or' and both dates set", async () => {
    // Regression: a customQuery-scoped scan ("angelone login" typed
    // directly) had the same AND-only limitation as the brand-family path -
    // this confirms the OR-splitting also applies here, not just to the
    // generated per-brand families.
    const { processor, scanQueue } = buildProcessor({
      createdFrom: new Date('2026-08-10'),
      createdTo: new Date('2026-08-10'),
      pushedFrom: new Date('2026-08-10'),
      pushedTo: new Date('2026-08-10'),
      dateFilterMode: 'or',
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(2);
    const queries = scanQueue.enqueueGithubSearch.mock.calls.map(
      (call) => (call[0] as { query: string }).query,
    );
    expect(
      queries.some(
        (q) => q === 'angelone login created:2026-08-10..2026-08-10',
      ),
    ).toBe(true);
    expect(
      queries.some((q) => q === 'angelone login pushed:2026-08-10..2026-08-10'),
    ).toBe(true);
  });

  it("issues one search job combining both qualifiers for a customQuery scan with dateFilterMode 'and' (default)", async () => {
    const { processor, scanQueue } = buildProcessor({
      createdFrom: new Date('2026-08-10'),
      createdTo: new Date('2026-08-10'),
      pushedFrom: new Date('2026-08-10'),
      pushedTo: new Date('2026-08-10'),
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueGithubSearch).toHaveBeenCalledTimes(1);
    const [payload] = scanQueue.enqueueGithubSearch.mock.calls[0] as [
      { query: string },
    ];
    expect(payload.query).toBe(
      'angelone login created:2026-08-10..2026-08-10 pushed:2026-08-10..2026-08-10',
    );
  });
});

describe('ScanOrchestratorProcessor internal audit mode', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();
  const brandId = new Types.ObjectId();

  function repoFixture(id: number) {
    return {
      id,
      full_name: `acme-corp/repo-${id}`,
      html_url: `https://github.com/acme-corp/repo-${id}`,
      description: null,
      stargazers_count: 0,
      forks_count: 0,
      fork: false,
      language: null,
      topics: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      pushed_at: '2024-01-02T00:00:00Z',
      owner: { login: 'acme-corp' },
      name: `repo-${id}`,
      default_branch: 'main',
      size: 10,
    };
  }

  function buildProcessor(overrides: {
    scan: Record<string, unknown>;
    listAllOwnerRepos: jest.Mock;
    brands?: Array<Record<string, unknown>>;
  }) {
    const scanQueue = {
      enqueueRepositoryAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue(overrides.scan),
      isCancelled: jest.fn().mockResolvedValue(false),
      markRunning: jest.fn().mockResolvedValue(undefined),
      markCompletedEarly: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isConfiguredForWorkspace: jest.fn().mockResolvedValue(true),
      isRateLimited: jest.fn().mockResolvedValue(false),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
      listAllOwnerRepos: overrides.listAllOwnerRepos,
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      claimRepositoryForAnalysis: jest.fn().mockResolvedValue(true),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve(
              overrides.brands ?? [
                {
                  _id: brandId,
                  name: 'AngelOne',
                  aliases: ['angelone'],
                  trustedGithubOwners: ['acme-corp'],
                },
              ],
            ),
        }),
      }),
    };
    const keywordModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = {
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };

    const processor = new ScanOrchestratorProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      { getResumePage: jest.fn().mockResolvedValue(1) } as never,
      github as never,
      { get: () => undefined } as never,
      brandModel as never,
      keywordModel as never,
      scanModel as never,
    );

    return { processor, scanQueue, scanState, github, incremental, scanModel };
  }

  it("enumerates every repo under the scoped brand's trusted owners and enqueues them with internalAudit:true", async () => {
    const { processor, scanQueue, scanModel } = buildProcessor({
      scan: {
        internalAudit: true,
        scopeBrandId: brandId,
        mode: 'incremental',
        maxRepos: 1000,
        checkpoint: {},
      },
      listAllOwnerRepos: jest
        .fn()
        .mockResolvedValue([repoFixture(1), repoFixture(2)]),
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysis).toHaveBeenCalledTimes(2);
    const [payload] = scanQueue.enqueueRepositoryAnalysis.mock.calls[0] as [
      {
        internalAudit: boolean;
        brands: Array<{ name: string }>;
        repo: { full_name: string };
      },
    ];
    expect(payload.internalAudit).toBe(true);
    expect(payload.brands).toHaveLength(1);
    expect(payload.brands[0].name).toBe('AngelOne');
    expect(payload.repo.full_name).toBe('acme-corp/repo-1');

    expect(scanModel.findByIdAndUpdate).toHaveBeenCalledWith(
      scanJobId,
      expect.objectContaining({
        $inc: expect.objectContaining({ awaitingAnalysis: 2 }),
      }),
    );
  });

  it('marks the scan completed early when the scoped brand has no trustedGithubOwners', async () => {
    const { processor, scanQueue, scanState } = buildProcessor({
      scan: {
        internalAudit: true,
        scopeBrandId: brandId,
        mode: 'incremental',
        maxRepos: 1000,
        checkpoint: {},
      },
      listAllOwnerRepos: jest.fn(),
      brands: [
        {
          _id: brandId,
          name: 'AngelOne',
          aliases: ['angelone'],
          trustedGithubOwners: [],
        },
      ],
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysis).not.toHaveBeenCalled();
    expect(scanState.markCompletedEarly).toHaveBeenCalledWith(
      scanJobId,
      expect.stringContaining('trustedGithubOwners'),
    );
  });

  it('surfaces the per-owner error reason instead of a bare "no repos found" message', async () => {
    const { processor, scanQueue, scanState } = buildProcessor({
      scan: {
        internalAudit: true,
        scopeBrandId: brandId,
        mode: 'incremental',
        maxRepos: 1000,
        checkpoint: {},
      },
      listAllOwnerRepos: jest
        .fn()
        .mockRejectedValue(new Error('Invalid GitHub owner')),
      brands: [
        {
          _id: brandId,
          name: 'AngelOne',
          aliases: ['angelone'],
          trustedGithubOwners: ['https://github.com/angel-one'],
        },
      ],
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysis).not.toHaveBeenCalled();
    expect(scanState.markCompletedEarly).toHaveBeenCalledWith(
      scanJobId,
      expect.stringContaining('Invalid GitHub owner'),
    );
  });

  it('stops enumerating once maxRepos is reached', async () => {
    const { processor, scanQueue } = buildProcessor({
      scan: {
        internalAudit: true,
        scopeBrandId: brandId,
        mode: 'incremental',
        maxRepos: 1,
        checkpoint: {},
      },
      listAllOwnerRepos: jest
        .fn()
        .mockResolvedValue([repoFixture(1), repoFixture(2), repoFixture(3)]),
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysis).toHaveBeenCalledTimes(1);
  });
});

describe('ScanOrchestratorProcessor analyze_pending mode', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();

  function repoDoc(githubId: number) {
    return {
      githubId,
      fullName: `evil/zerodha-clone-${githubId}`,
      url: `https://github.com/evil/zerodha-clone-${githubId}`,
      description: '',
      stars: 0,
      forks: 0,
      isFork: false,
      language: '',
      topics: [],
      githubCreatedAt: new Date('2023-01-01T00:00:00Z'),
      githubUpdatedAt: new Date('2023-01-02T00:00:00Z'),
      githubPushedAt: new Date('2023-01-02T00:00:00Z'),
      owner: 'evil',
      name: `zerodha-clone-${githubId}`,
      defaultBranch: 'main',
    };
  }

  function buildProcessor(overrides: {
    pendingIds: number[];
    repos: Record<number, ReturnType<typeof repoDoc> | undefined>;
  }) {
    // Deliberately no enqueueGithubSearch mock - analyze_pending must never
    // reach the search-dispatch path at all; calling it would throw "not a
    // function" and fail the test loudly.
    const scanQueue = {
      enqueueRepositoryAnalysisBulk: jest
        .fn()
        .mockImplementation((items: unknown[]) =>
          Promise.resolve(items.map(() => ({}))),
        ),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({
        mode: 'analyze_pending',
        maxRepos: 1000,
        checkpoint: {},
      }),
      isCancelled: jest.fn().mockResolvedValue(false),
      markRunning: jest.fn().mockResolvedValue(undefined),
      markCompletedEarly: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isConfiguredForWorkspace: jest.fn().mockResolvedValue(true),
      isRateLimited: jest.fn().mockResolvedValue(false),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      listPendingAnalysisGithubIds: jest
        .fn()
        .mockResolvedValue(overrides.pendingIds),
      // Mirrors claimManyForAnalysis's real contract: returns whichever of
      // the requested ids aren't already known (no dedup fixtures need that
      // here, so it's just "claim everything asked for").
      claimManyForAnalysis: jest.fn((_scanJobId: string, ids: number[]) =>
        Promise.resolve(ids),
      ),
      findManyByGithubIds: jest.fn((_ws: string, ids: number[]) =>
        Promise.resolve(
          ids
            .map((id) => overrides.repos[id])
            .filter((r): r is ReturnType<typeof repoDoc> => Boolean(r)),
        ),
      ),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const keywordModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = { findByIdAndUpdate: jest.fn().mockResolvedValue({}) };

    const processor = new ScanOrchestratorProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      { getResumePage: jest.fn().mockResolvedValue(1) } as never,
      github as never,
      { get: () => undefined } as never,
      brandModel as never,
      keywordModel as never,
      scanModel as never,
    );

    return { processor, scanQueue, scanState, incremental, scanModel };
  }

  it('skips search entirely and force-analyzes every repo pending analysis workspace-wide', async () => {
    const { processor, scanQueue, scanModel } = buildProcessor({
      pendingIds: [301, 302],
      repos: { 301: repoDoc(301), 302: repoDoc(302) },
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    // Bulk-enqueued in a single call (one Redis round-trip for the whole
    // batch), not once per repo - see bulkEnqueueAnalysis.
    expect(scanQueue.enqueueRepositoryAnalysisBulk).toHaveBeenCalledTimes(1);
    const [items] = scanQueue.enqueueRepositoryAnalysisBulk.mock.calls[0] as [
      Array<{
        forceFullScan: boolean;
        repo: { id: number };
        mode: string;
        internalAudit?: boolean;
      }>,
    ];
    expect(items).toHaveLength(2);
    const [payload] = items;
    // forceFullScan guarantees decideRescan analyzes it regardless of the
    // repo's prior state - these repos have never actually been analyzed
    // (only discovered), so this must not be skippable as "unchanged."
    expect(payload.forceFullScan).toBe(true);
    expect(payload.repo.id).toBe(301);
    expect(payload.mode).toBe('analyze_pending');
    // Regression: omitting this left upsertRepository's internalAudit
    // undefined, which silently never wrote Repository.origin at all -
    // permanently hiding the repo from the Repositories page's
    // origin:'external' filter. Only discoveryOnly-deferred repos ever
    // reach analyze_pending (internal audit runs full analysis
    // immediately, never defers), so this is always external.
    expect(payload.internalAudit).toBe(false);

    const updateCall = scanModel.findByIdAndUpdate.mock.calls.find(
      (call) => call[1]?.$inc?.reposDiscovered,
    ) as [string, { $inc: Record<string, number> }];
    expect(updateCall[1].$inc.reposDiscovered).toBe(2);
    expect(updateCall[1].$inc.awaitingAnalysis).toBe(2);
  });

  it('marks the scan completed with no work when nothing is pending analysis', async () => {
    const { processor, scanState, scanQueue } = buildProcessor({
      pendingIds: [],
      repos: {},
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysisBulk).not.toHaveBeenCalled();
    expect(scanState.markCompletedEarly).toHaveBeenCalledWith(
      scanJobId,
      'No pending discovered repositories to analyze',
    );
  });

  it('skips (and unclaims) a pending id whose repository record has since disappeared', async () => {
    const { processor, scanQueue, scanModel } = buildProcessor({
      pendingIds: [301],
      repos: { 301: undefined },
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysisBulk).not.toHaveBeenCalled();
    expect(scanModel.findByIdAndUpdate).toHaveBeenCalledWith(
      scanJobId,
      expect.objectContaining({
        $pull: { 'checkpoint.pendingGithubIds': { $in: [301] } },
      }),
    );
  });
});

describe('ScanOrchestratorProcessor reanalyze_existing mode', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();

  function repoDoc(githubId: number) {
    return {
      githubId,
      fullName: `evil/zerodha-clone-${githubId}`,
      url: `https://github.com/evil/zerodha-clone-${githubId}`,
      description: '',
      stars: 0,
      forks: 0,
      isFork: false,
      language: '',
      topics: [],
      githubCreatedAt: new Date('2023-01-01T00:00:00Z'),
      githubUpdatedAt: new Date('2023-01-02T00:00:00Z'),
      githubPushedAt: new Date('2023-01-02T00:00:00Z'),
      owner: 'evil',
      name: `zerodha-clone-${githubId}`,
      defaultBranch: 'main',
    };
  }

  function buildProcessor(overrides: {
    analyzedIds: number[];
    repos: Record<number, ReturnType<typeof repoDoc> | undefined>;
  }) {
    // Deliberately no enqueueGithubSearch mock - reanalyze_existing must
    // never reach the search-dispatch path at all, same as analyze_pending.
    const scanQueue = {
      enqueueRepositoryAnalysisBulk: jest
        .fn()
        .mockImplementation((items: unknown[]) =>
          Promise.resolve(items.map(() => ({}))),
        ),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({
        mode: 'reanalyze_existing',
        maxRepos: 1000,
        checkpoint: {},
      }),
      isCancelled: jest.fn().mockResolvedValue(false),
      markRunning: jest.fn().mockResolvedValue(undefined),
      markCompletedEarly: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isConfiguredForWorkspace: jest.fn().mockResolvedValue(true),
      isRateLimited: jest.fn().mockResolvedValue(false),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      listAnalyzedGithubIds: jest.fn().mockResolvedValue(overrides.analyzedIds),
      claimManyForAnalysis: jest.fn((_scanJobId: string, ids: number[]) =>
        Promise.resolve(ids),
      ),
      findManyByGithubIds: jest.fn((_ws: string, ids: number[]) =>
        Promise.resolve(
          ids
            .map((id) => overrides.repos[id])
            .filter((r): r is ReturnType<typeof repoDoc> => Boolean(r)),
        ),
      ),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const keywordModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };
    const scanModel = { findByIdAndUpdate: jest.fn().mockResolvedValue({}) };

    const processor = new ScanOrchestratorProcessor(
      scanQueue as never,
      scanState as never,
      {} as never,
      incremental as never,
      { getResumePage: jest.fn().mockResolvedValue(1) } as never,
      github as never,
      { get: () => undefined } as never,
      brandModel as never,
      keywordModel as never,
      scanModel as never,
    );

    return { processor, scanQueue, scanState, incremental, scanModel };
  }

  it('skips search entirely and force-analyzes every already-analyzed repo workspace-wide', async () => {
    const { processor, scanQueue, scanModel } = buildProcessor({
      analyzedIds: [401, 402],
      repos: { 401: repoDoc(401), 402: repoDoc(402) },
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysisBulk).toHaveBeenCalledTimes(1);
    const [items] = scanQueue.enqueueRepositoryAnalysisBulk.mock.calls[0] as [
      Array<{
        forceFullScan: boolean;
        repo: { id: number };
        mode: string;
        internalAudit?: boolean;
      }>,
    ];
    expect(items).toHaveLength(2);
    const [payload] = items;
    // forceFullScan guarantees decideRescan re-analyzes it regardless of
    // whether its commit SHA is unchanged - the whole point of this mode is
    // re-checking content against a keyword list that may have changed
    // since the repo was last analyzed, not whether the code itself moved.
    expect(payload.forceFullScan).toBe(true);
    expect(payload.repo.id).toBe(401);
    expect(payload.mode).toBe('reanalyze_existing');
    expect(payload.internalAudit).toBe(false);

    const updateCall = scanModel.findByIdAndUpdate.mock.calls.find(
      (call) => call[1]?.$inc?.reposDiscovered,
    ) as [string, { $inc: Record<string, number> }];
    expect(updateCall[1].$inc.reposDiscovered).toBe(2);
    expect(updateCall[1].$inc.awaitingAnalysis).toBe(2);
  });

  it('marks the scan completed with no work when nothing already-analyzed matches the scope', async () => {
    const { processor, scanState, scanQueue } = buildProcessor({
      analyzedIds: [],
      repos: {},
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(scanQueue.enqueueRepositoryAnalysisBulk).not.toHaveBeenCalled();
    expect(scanState.markCompletedEarly).toHaveBeenCalledWith(
      scanJobId,
      'No already-analyzed repositories match this scope',
    );
  });
});

describe('ScanOrchestratorProcessor search query page resumption', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();
  const brandId = new Types.ObjectId();

  function buildProcessor(scanOverrides: Record<string, unknown>) {
    const scanQueue = {
      enqueueGithubSearch: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({
        mode: 'incremental',
        maxRepos: 1000,
        checkpoint: { searchCursors: {} },
        ...scanOverrides,
      }),
      isCancelled: jest.fn().mockResolvedValue(false),
      markRunning: jest.fn().mockResolvedValue(undefined),
      setQueries: jest.fn().mockResolvedValue(undefined),
      markCompletedEarly: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const github = {
      isConfiguredForWorkspace: jest.fn().mockResolvedValue(true),
      isRateLimited: jest.fn().mockResolvedValue(false),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const incremental = {
      currentRulesetVersion: jest.fn().mockReturnValue('ruleset'),
      saveCheckpoint: jest.fn().mockResolvedValue(undefined),
      listFailedGithubIds: jest.fn().mockResolvedValue([]),
    };
    const pipeline = {
      buildSearchQueries: jest
        .fn()
        .mockReturnValue([
          { kind: 'repositories', family: 'phishing', query: '"acme" login' },
        ]),
    };
    const discoveryCursor = {
      getResumePage: jest.fn().mockResolvedValue(7),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve([
              {
                _id: brandId,
                name: 'Acme',
                aliases: ['acme'],
                trustedGithubOwners: [],
              },
            ]),
        }),
      }),
    };
    const keywordModel = {
      find: jest
        .fn()
        .mockReturnValue({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
    };
    const scanModel = { findByIdAndUpdate: jest.fn().mockResolvedValue({}) };

    const processor = new ScanOrchestratorProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      discoveryCursor as never,
      github as never,
      { get: () => undefined } as never,
      brandModel as never,
      keywordModel as never,
      scanModel as never,
      null,
    );

    return { processor, scanQueue, discoveryCursor, incremental };
  }

  it('starts at page 1 and never consults the durable cursor when continueDiscovery is not set (unchanged default behavior)', async () => {
    const { processor, scanQueue, discoveryCursor, incremental } =
      buildProcessor({
        continueDiscovery: false,
      });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(discoveryCursor.getResumePage).not.toHaveBeenCalled();
    const [payload] = scanQueue.enqueueGithubSearch.mock.calls[0] as [
      { page: number },
    ];
    expect(payload.page).toBe(1);
    // Recorded even when nothing resumed - "page 1" is itself the visible,
    // checkable proof this query started fresh, not just an assumption.
    expect(incremental.saveCheckpoint).toHaveBeenCalledWith(
      scanJobId,
      expect.objectContaining({ searchStartPages: { '0': 1 } }),
    );
  });

  it("resumes from this workspace's durable per-query cursor when continueDiscovery is set and this is a fresh scan", async () => {
    const { processor, scanQueue, discoveryCursor, incremental } =
      buildProcessor({
        continueDiscovery: true,
      });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(discoveryCursor.getResumePage).toHaveBeenCalledWith(
      workspaceId,
      'repositories',
      '"acme" login',
    );
    const [payload] = scanQueue.enqueueGithubSearch.mock.calls[0] as [
      { page: number },
    ];
    expect(payload.page).toBe(7);
    // This is the checkable record the scan detail page reads to show
    // "resumed from page 7" instead of asking the user to just trust it.
    expect(incremental.saveCheckpoint).toHaveBeenCalledWith(
      scanJobId,
      expect.objectContaining({ searchStartPages: { '0': 7 } }),
    );
  });

  it("prefers this scan's own in-progress checkpoint (crash-resume) over the durable cross-scan cursor", async () => {
    const { processor, scanQueue, discoveryCursor } = buildProcessor({
      continueDiscovery: true,
      checkpoint: { searchCursors: { '0': 3 } },
    });

    await processor.process({
      data: { workspaceId, scanJobId },
      opts: { priority: 5 },
    } as never);

    expect(discoveryCursor.getResumePage).not.toHaveBeenCalled();
    const [payload] = scanQueue.enqueueGithubSearch.mock.calls[0] as [
      { page: number },
    ];
    expect(payload.page).toBe(4);
  });
});
