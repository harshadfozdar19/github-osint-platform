import { Types } from 'mongoose';
import { ScanJobStatus } from '../common/enums';
import { ScansService } from './scans.service';

function chainable<T>(result: T) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.find = jest.fn(self);
  chain.select = jest.fn(self);
  chain.sort = jest.fn(self);
  chain.skip = jest.fn(self);
  chain.limit = jest.fn(self);
  chain.lean = jest.fn(self);
  chain.distinct = jest.fn(self);
  chain.populate = jest.fn(self);
  chain.exec = jest.fn().mockResolvedValue(result);
  return chain;
}

describe('ScansService.listRepositories', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const brandId = new Types.ObjectId();
  const scanJobId = new Types.ObjectId();
  const analyzedRepoId = new Types.ObjectId();
  const pendingRepoId = new Types.ObjectId();

  function buildService(overrides: {
    repos?: Record<string, unknown>[];
    findings?: Record<string, unknown>[];
    scanJobs?: Record<string, unknown>[];
    brands?: Record<string, unknown>[];
  }) {
    const repos = overrides.repos ?? [];
    const repoModel = {
      find: jest.fn().mockReturnValue(chainable(repos)),
      countDocuments: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(repos.length),
      }),
    };
    const findingModel = {
      find: jest.fn().mockReturnValue(chainable(overrides.findings ?? [])),
    };
    const scanModel = {
      find: jest.fn().mockReturnValue(chainable(overrides.scanJobs ?? [])),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue(chainable(overrides.brands ?? [])),
    };
    const scanQueue = {};
    const incremental = {};
    const github = {};
    const keywordRotation = {};

    const service = new ScansService(
      scanModel as never,
      repoModel as never,
      brandModel as never,
      findingModel as never,
      scanQueue as never,
      incremental as never,
      github as never,
      keywordRotation as never,
    );
    return { service, repoModel };
  }

  it('uses the Finding (exact match location + text) for an already-analyzed repo, not the discovering scan', async () => {
    const { service } = buildService({
      repos: [
        {
          _id: analyzedRepoId,
          fullName: 'evil/zerodha-clone',
          lastScanJobId: scanJobId,
        },
      ],
      findings: [
        {
          repositoryId: analyzedRepoId,
          brandName: 'Zerodha',
          riskScore: 80,
          brandMatchEvidence: {
            location: 'file_content',
            matchedText: 'zerodha.com/login',
            filePath: 'src/config.py',
            lineNumber: 12,
          },
        },
      ],
    });

    const result = await service.listRepositories(workspaceId, 1, 20);
    expect(result.data).toHaveLength(1);
    const repo = result.data[0] as Record<string, unknown>;
    expect(repo.matchConfirmed).toBe(true);
    expect(repo.matchedBrand).toBe('Zerodha');
    expect(repo.matchLocation).toBe('file_content');
    expect(repo.matchedText).toBe('zerodha.com/login');
    expect(repo.matchFilePath).toBe('src/config.py');
    expect(repo.matchLineNumber).toBe(12);
  });

  it("falls back to the discovering scan's brand + keyword (unconfirmed) for a repo with no Finding yet", async () => {
    const { service } = buildService({
      repos: [
        {
          _id: pendingRepoId,
          fullName: 'evil/otp-bypass-tool',
          lastScanJobId: scanJobId,
          pendingAnalysis: true,
        },
      ],
      findings: [],
      scanJobs: [
        { _id: scanJobId, scopeBrandId: brandId, scopeKeyword: 'otp bypass' },
      ],
      brands: [{ _id: brandId, name: 'Zerodha' }],
    });

    const result = await service.listRepositories(workspaceId, 1, 20);
    expect(result.data).toHaveLength(1);
    const repo = result.data[0] as Record<string, unknown>;
    expect(repo.matchConfirmed).toBe(false);
    expect(repo.matchedBrand).toBe('Zerodha');
    expect(repo.matchKeyword).toBe('otp bypass');
    expect(repo.matchLocation).toBeUndefined();
  });

  it('surfaces additionalBrandMatches as named "also found for" entries alongside a confirmed Finding', async () => {
    const growwId = new Types.ObjectId();
    const { service } = buildService({
      repos: [
        {
          _id: analyzedRepoId,
          fullName: 'divgandhi179-pixel/Broker-aggregator',
          lastScanJobId: scanJobId,
          discoveryBrandId: growwId,
          additionalBrandMatches: [{ brandId, keyword: 'motilal oswal' }],
        },
      ],
      findings: [
        {
          repositoryId: analyzedRepoId,
          brandName: 'Groww',
          riskScore: 40,
          brandMatchEvidence: { location: 'description' },
        },
      ],
      brands: [{ _id: brandId, name: 'Motilal Oswal' }],
    });

    const result = await service.listRepositories(workspaceId, 1, 20);
    const repo = result.data[0] as Record<string, unknown>;
    expect(repo.matchedBrand).toBe('Groww');
    expect(repo.additionalBrands).toEqual([
      { name: 'Motilal Oswal', keyword: 'motilal oswal' },
    ]);
  });

  it('surfaces additionalBrandMatches for a not-yet-analyzed (discovery-only) repo too', async () => {
    const growwId = new Types.ObjectId();
    const { service } = buildService({
      repos: [
        {
          _id: pendingRepoId,
          fullName: 'niki019/MotilalOswal-AMU-Groww-RAG-chatbot',
          lastScanJobId: scanJobId,
          pendingAnalysis: true,
          discoveryBrandId: growwId,
          additionalBrandMatches: [{ brandId, keyword: 'motilal oswal' }],
        },
      ],
      findings: [],
      scanJobs: [
        { _id: scanJobId, scopeBrandId: growwId, scopeKeyword: 'groww' },
      ],
      brands: [
        { _id: growwId, name: 'Groww' },
        { _id: brandId, name: 'Motilal Oswal' },
      ],
    });

    const result = await service.listRepositories(workspaceId, 1, 20);
    const repo = result.data[0] as Record<string, unknown>;
    expect(repo.matchedBrand).toBe('Groww');
    expect(repo.additionalBrands).toEqual([
      { name: 'Motilal Oswal', keyword: 'motilal oswal' },
    ]);
  });

  it('omits an additional-brand entry whose brandId no longer resolves to a real brand (deleted company)', async () => {
    const missingBrandId = new Types.ObjectId();
    const { service } = buildService({
      repos: [
        {
          _id: analyzedRepoId,
          fullName: 'org/repo',
          lastScanJobId: scanJobId,
          additionalBrandMatches: [{ brandId: missingBrandId, keyword: 'x' }],
        },
      ],
      findings: [
        {
          repositoryId: analyzedRepoId,
          brandName: 'Zerodha',
          riskScore: 80,
          brandMatchEvidence: {},
        },
      ],
      brands: [],
    });

    const result = await service.listRepositories(workspaceId, 1, 20);
    const repo = result.data[0] as Record<string, unknown>;
    expect(repo.additionalBrands).toEqual([]);
  });

  it('returns an empty page cleanly with no lookups when there are no repos', async () => {
    const { service } = buildService({ repos: [] });
    const result = await service.listRepositories(workspaceId, 1, 20);
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('filters by discoveryBrandId and discoveryKeyword when both are given - powers the sequential scheduler\'s per-keyword "View" link', async () => {
    const { service, repoModel } = buildService({ repos: [] });
    await service.listRepositories(workspaceId, 1, 20, {
      brandId: String(brandId),
      keyword: 'angel one',
    });
    const filter = repoModel.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.discoveryBrandId).toEqual(brandId);
    expect(filter.discoveryKeyword).toBe('angel one');
  });

  it('ignores an invalid brandId instead of throwing', async () => {
    const { service, repoModel } = buildService({ repos: [] });
    await service.listRepositories(workspaceId, 1, 20, {
      brandId: 'not-an-id',
    });
    const filter = repoModel.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.discoveryBrandId).toBeUndefined();
  });

  it('filters by language with a case-insensitive exact match, escaping regex metacharacters', async () => {
    const { service, repoModel } = buildService({ repos: [] });
    await service.listRepositories(workspaceId, 1, 20, { language: 'C++' });
    const filter = repoModel.find.mock.calls[0][0] as {
      language: { $regex: string; $options: string };
    };
    expect(filter.language.$options).toBe('i');
    expect(filter.language.$regex).toBe('^C\\+\\+$');
    // Exact match, not substring - "C" alone must not match "C++".
    expect(new RegExp(filter.language.$regex, 'i').test('C')).toBe(false);
    expect(new RegExp(filter.language.$regex, 'i').test('c++')).toBe(true);
  });

  it('builds $gte/$lte range filters for each of the four date-ish columns independently', async () => {
    const { service, repoModel } = buildService({ repos: [] });
    const discoveredFrom = new Date('2026-01-01');
    const githubCreatedTo = new Date('2026-02-01');
    const pushedFrom = new Date('2026-03-01');
    const lastScannedTo = new Date('2026-04-01');
    await service.listRepositories(workspaceId, 1, 20, {
      discoveredFrom,
      githubCreatedTo,
      pushedFrom,
      lastScannedTo,
    });
    const filter = repoModel.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.createdAt).toEqual({ $gte: discoveredFrom });
    expect(filter.githubCreatedAt).toEqual({ $lte: githubCreatedTo });
    expect(filter.githubPushedAt).toEqual({ $gte: pushedFrom });
    expect(filter.lastScannedAt).toEqual({ $lte: lastScannedTo });
  });

  it('scopes matchLocation to repos whose Finding evidence matches, plus unconfirmed repos whose own discoveryMatchedField matches - never a repo whose Finding disagrees', async () => {
    const locationMatchId = new Types.ObjectId();
    const otherFindingRepoId = new Types.ObjectId();
    const findSpy = jest
      .fn()
      .mockReturnValueOnce(chainable([locationMatchId]))
      .mockReturnValueOnce(chainable([locationMatchId, otherFindingRepoId]));
    const repoModel = {
      find: jest.fn().mockReturnValue(chainable([])),
      countDocuments: jest
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const service = new ScansService(
      {} as never,
      repoModel as never,
      {} as never,
      { find: findSpy } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.listRepositories(workspaceId, 1, 20, {
      matchLocation: 'file_content',
    });
    const filter = repoModel.find.mock.calls[0][0] as {
      $or: Array<Record<string, unknown>>;
    };
    expect(filter.$or[0]).toEqual({ _id: { $in: [locationMatchId] } });
    expect(filter.$or[1]).toEqual({
      discoveryMatchedField: 'file_content',
      _id: { $nin: [locationMatchId, otherFindingRepoId] },
    });
  });
});

describe('ScansService.listDistinctRepositoryLanguages', () => {
  it('returns non-empty languages sorted alphabetically, scoped to keyword-discovered repos only', async () => {
    const workspaceId = new Types.ObjectId().toHexString();
    const distinctSpy = jest.fn().mockReturnValue({
      exec: () => Promise.resolve(['Python', 'Go', 'JavaScript']),
    });
    const repoModel = { distinct: distinctSpy };
    const service = new ScansService(
      {} as never,
      repoModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await service.listDistinctRepositoryLanguages(workspaceId);
    expect(result).toEqual(['Go', 'JavaScript', 'Python']);
    const [field, filter] = distinctSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(field).toBe('language');
    expect(filter.origin).toBe('external');
  });
});

describe('ScansService.getRecentChanges', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  it('queries recentPushes scoped to external origin and recent githubPushedAt, sorted newest-pushed first', async () => {
    const repoFindSpy = jest.fn().mockReturnValue(chainable([]));
    const findingFindSpy = jest.fn().mockReturnValue(chainable([]));
    const repoModel = { find: repoFindSpy };
    const findingModel = { find: findingFindSpy };
    const service = new ScansService(
      {} as never,
      repoModel as never,
      {} as never,
      findingModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.getRecentChanges(workspaceId, { days: 3, limit: 5 });

    const repoFilter = repoFindSpy.mock.calls[0][0] as {
      origin: string;
      githubPushedAt: { $gte: Date };
    };
    expect(repoFilter.origin).toBe('external');
    expect(repoFilter.githubPushedAt.$gte.getTime()).toBeLessThan(Date.now());
    const repoChain = repoFindSpy.mock.results[0].value as {
      sort: jest.Mock;
      limit: jest.Mock;
    };
    expect(repoChain.sort).toHaveBeenCalledWith({ githubPushedAt: -1 });
    expect(repoChain.limit).toHaveBeenCalledWith(5);
  });

  it('queries recentFindingChanges for new/reopened findings only, dropping any whose repo no longer exists', async () => {
    const survivingRepoId = new Types.ObjectId();
    const findingFindSpy = jest.fn().mockReturnValue(
      chainable([
        {
          _id: new Types.ObjectId(),
          repositoryId: {
            _id: survivingRepoId,
            fullName: 'acme/live-repo',
            url: 'https://github.com/acme/live-repo',
          },
          brandName: 'Zerodha',
          severity: 'high',
          summary: 'Exposed AWS key',
          lastChangeType: 'new',
          lastSeenAt: new Date(),
        },
        {
          _id: new Types.ObjectId(),
          // Repo was deleted since - populate leaves this null/undefined.
          repositoryId: null,
          brandName: 'Zerodha',
          severity: 'high',
          summary: 'Orphaned finding',
          lastChangeType: 'reopened',
          lastSeenAt: new Date(),
        },
      ]),
    );
    const repoModel = { find: jest.fn().mockReturnValue(chainable([])) };
    const findingModel = { find: findingFindSpy };
    const service = new ScansService(
      {} as never,
      repoModel as never,
      {} as never,
      findingModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.getRecentChanges(workspaceId);

    const findingFilter = findingFindSpy.mock.calls[0][0] as {
      origin: string;
      lastChangeType: { $in: string[] };
    };
    expect(findingFilter.origin).toBe('external');
    expect(findingFilter.lastChangeType.$in).toEqual(['new', 'reopened']);
    expect(result.recentFindingChanges).toHaveLength(1);
    expect(result.recentFindingChanges[0].repository).toEqual({
      _id: survivingRepoId,
      fullName: 'acme/live-repo',
      url: 'https://github.com/acme/live-repo',
    });
    expect(result.recentFindingChanges[0].changeType).toBe('new');
  });
});

describe('ScansService.list', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  function buildService(rows: Record<string, unknown>[] = []) {
    const scanModel = {
      find: jest.fn().mockReturnValue(chainable(rows)),
      countDocuments: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(rows.length),
      }),
    };
    const service = new ScansService(
      scanModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, scanModel };
  }

  it('has no status clause in the filter when no status is requested (full history, unchanged default behavior)', async () => {
    const { service, scanModel } = buildService();
    await service.list(workspaceId, 1, 20);
    const filter = scanModel.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.status).toBeUndefined();
  });

  it('restricts to the given statuses via $in - powers the Scans page\'s "Currently running" section, which needs every active scan regardless of how far it\'s fallen down the newest-first history (a real scenario once the sequential scheduler and per-keyword auto-restarts have created enough newer scans since)', async () => {
    const { service, scanModel } = buildService();
    await service.list(workspaceId, 1, 100, {
      status: [ScanJobStatus.QUEUED, ScanJobStatus.RUNNING],
    });
    const filter = scanModel.find.mock.calls[0][0] as {
      status: { $in: ScanJobStatus[] };
    };
    expect(filter.status).toEqual({
      $in: [ScanJobStatus.QUEUED, ScanJobStatus.RUNNING],
    });
  });

  it('ignores an empty status array the same as no filter at all', async () => {
    const { service, scanModel } = buildService();
    await service.list(workspaceId, 1, 20, { status: [] });
    const filter = scanModel.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.status).toBeUndefined();
  });
});
