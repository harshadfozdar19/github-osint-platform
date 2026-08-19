import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { ScanPipelineService } from './scan-pipeline.service';

function buildService(github: unknown = {}, cloneScan: unknown = {}) {
  return new ScanPipelineService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    github as never,
    {} as never,
    {} as never,
    { get: () => undefined } as never,
    cloneScan as never,
  );
}

const noCloneScan = { shouldAttempt: jest.fn().mockResolvedValue(false) };

describe('ScanPipelineService.matchBrand', () => {
  it('matches on a trusted GitHub owner even with no brand name in the repo metadata', () => {
    const service = buildService();
    const angelOne = {
      _id: new Types.ObjectId(),
      name: 'AngelOne',
      aliases: ['angelone'],
      trustedGithubOwners: ['angel-one-tech'],
    };
    const result = service.matchBrand([angelOne], {
      full_name: 'angel-one-tech/backend-services',
      description: 'Internal services monorepo',
      topics: [],
      owner: { login: 'angel-one-tech' },
    });
    expect(result).toBe(angelOne);
  });

  it('is case-insensitive when matching a trusted owner', () => {
    const service = buildService();
    const angelOne = {
      _id: new Types.ObjectId(),
      name: 'AngelOne',
      aliases: [],
      trustedGithubOwners: ['Angel-One-Tech'],
    };
    const result = service.matchBrand([angelOne], {
      full_name: 'angel-one-tech/some-repo',
      description: '',
      topics: [],
      owner: { login: 'angel-one-tech' },
    });
    expect(result).toBe(angelOne);
  });

  it('still falls back to content matching when the owner is not a trusted account', () => {
    const service = buildService();
    const phonepe = {
      _id: new Types.ObjectId(),
      name: 'PhonePe',
      aliases: ['phonepe'],
      trustedGithubOwners: ['phonepe-official'],
    };
    const result = service.matchBrand([phonepe], {
      full_name: 'evil/phonepe-login-apk',
      description: '',
      topics: [],
      owner: { login: 'evil' },
    });
    expect(result).toBe(phonepe);
  });

  it('returns undefined when neither the owner nor the content match any brand', () => {
    const service = buildService();
    const acme = {
      _id: new Types.ObjectId(),
      name: 'Acme',
      aliases: ['acme'],
      trustedGithubOwners: ['acme-corp'],
    };
    const result = service.matchBrand([acme], {
      full_name: 'someone/unrelated-project',
      description: 'Just a normal repo',
      topics: [],
      owner: { login: 'someone' },
    });
    expect(result).toBeUndefined();
  });
});

describe('ScanPipelineService.fingerprint (branch isolation)', () => {
  function getFingerprintFn(service: ScanPipelineService) {
    return (
      service as unknown as {
        fingerprint: (
          githubId: number,
          ruleIds: string[],
          branch?: string,
        ) => string;
      }
    ).fingerprint.bind(service);
  }

  it('is byte-for-byte identical to the pre-branch-field format when no branch is given, so every already-stored default-branch Finding keeps matching on its next scan', () => {
    const service = buildService();
    const fingerprint = getFingerprintFn(service);
    const expected = createHash('sha256')
      .update('123:phishing-keyword,secret-detected')
      .digest('hex')
      .slice(0, 32);
    expect(fingerprint(123, ['secret-detected', 'phishing-keyword'])).toBe(
      expected,
    );
  });

  it('produces a DIFFERENT fingerprint when a branch is given, even for the identical githubId+ruleIds, so a side-branch finding can never collide with (and silently overwrite the evidence of) the real default-branch finding', () => {
    const service = buildService();
    const fingerprint = getFingerprintFn(service);
    const withoutBranch = fingerprint(42, ['secret-detected']);
    const withBranch = fingerprint(42, ['secret-detected'], 'feature/x');
    expect(withBranch).not.toBe(withoutBranch);
  });

  it('is deterministic per branch regardless of rule order, so a repeat scan of the same branch updates the same Finding instead of creating duplicates', () => {
    const service = buildService();
    const fingerprint = getFingerprintFn(service);
    expect(fingerprint(42, ['a', 'b'], 'feature/x')).toBe(
      fingerprint(42, ['b', 'a'], 'feature/x'),
    );
  });

  it('gives two different branches of the same repo their own separate fingerprints', () => {
    const service = buildService();
    const fingerprint = getFingerprintFn(service);
    expect(fingerprint(42, ['secret-detected'], 'feature/a')).not.toBe(
      fingerprint(42, ['secret-detected'], 'feature/b'),
    );
  });
});

describe('ScanPipelineService.runDetectionAndPersist - branch scoping never resolves unrelated findings', () => {
  const minimalCtx = {
    fullName: 'acme/demo',
    owner: 'acme',
    name: 'demo',
    description: '',
    topics: [],
    language: '',
    stars: 0,
    forks: 0,
    isFork: false,
    filePaths: [],
    readmeText: '',
    smallFileTexts: [],
  };

  function buildDetectionHarness() {
    const findingModel = {
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    const detectionModel = {
      insertMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({}),
    };
    const fingerprintModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    };
    const detectionEngine = { analyze: jest.fn().mockReturnValue([]) };
    const riskScoring = { calculate: jest.fn() };
    const service = new ScanPipelineService(
      {} as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      {} as never,
      detectionEngine as never,
      riskScoring,
      { get: () => undefined } as never,
      {} as never,
    );
    return { service, findingModel };
  }

  const baseInput = {
    workspaceId: new Types.ObjectId().toHexString(),
    scanJobId: new Types.ObjectId().toHexString(),
    repositoryDbId: new Types.ObjectId().toHexString(),
    githubId: 42,
    fullName: 'acme/demo',
    ctx: minimalCtx,
  };

  it("does NOT resolve the repo's other open findings when a branch-scoped scan turns up nothing on that branch - it only saw one branch, not the whole repo", async () => {
    const { service, findingModel } = buildDetectionHarness();
    await service.runDetectionAndPersist({ ...baseInput, branch: 'feature/x' });
    expect(findingModel.find).not.toHaveBeenCalled();
  });

  it("still resolves the repo's other open findings for a normal (non-branch) scan that turns up nothing - existing default-branch behavior is unchanged", async () => {
    const { service, findingModel } = buildDetectionHarness();
    await service.runDetectionAndPersist(baseInput);
    expect(findingModel.find).toHaveBeenCalled();
  });
});

describe('ScanPipelineService.fetchRepositoryContext - pool-wide brand attribution', () => {
  const angelOne = {
    id: 'brand-angelone',
    name: 'AngelOne',
    aliases: ['angelone'],
    trustedGithubOwners: [],
  };
  const phonepe = {
    id: 'brand-phonepe',
    name: 'PhonePe',
    aliases: ['phonepe'],
    trustedGithubOwners: [],
  };
  const repoItem = {
    id: 1,
    full_name: 'someone/generic-tool',
    html_url: 'https://github.com/someone/generic-tool',
    description: 'A generic internal utility, no brand mentioned here',
    stargazers_count: 3,
    forks_count: 0,
    fork: false,
    language: 'Python',
    topics: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pushed_at: new Date().toISOString(),
    owner: { login: 'someone' },
    name: 'generic-tool',
    default_branch: 'main',
    size: 100,
  };

  it('attributes a repo to a brand whose only mention is in file content, even with no brands pre-matched', async () => {
    const github = {
      listRootPaths: jest.fn().mockResolvedValue(['scraper.py']),
      getReadme: jest.fn().mockResolvedValue({ text: '' }),
      getSmallTextFile: jest
        .fn()
        .mockResolvedValue('endpoint = "https://phonepe.com/pay"'),
      getUserProfile: jest.fn().mockResolvedValue(null),
    };
    const service = buildService(github, noCloneScan);

    const result = await service.fetchRepositoryContext(repoItem, [
      angelOne,
      phonepe,
    ]);

    expect(result.ctx.matchedBrandId).toBe('brand-phonepe');
    expect(result.ctx.matchedBrandName).toBe('PhonePe');
    // Owner-account lookup fires once a brand matches and the owner isn't
    // already a trusted account for that brand.
    expect(github.getUserProfile).toHaveBeenCalledWith('someone', {});
  });

  it('leaves matchedBrandName unset when no monitored brand appears anywhere', async () => {
    const github = {
      listRootPaths: jest.fn().mockResolvedValue(['app.py']),
      getReadme: jest.fn().mockResolvedValue({ text: '' }),
      getSmallTextFile: jest
        .fn()
        .mockResolvedValue('nothing brand-related here'),
    };
    const service = buildService(github, noCloneScan);

    const result = await service.fetchRepositoryContext(repoItem, [
      angelOne,
      phonepe,
    ]);

    expect(result.ctx.matchedBrandId).toBeUndefined();
    expect(result.ctx.matchedBrandName).toBeUndefined();
  });
});

describe('ScanPipelineService.appendHistoricalSecretSignals', () => {
  it('captures commit messages and authors onto ctx for brand-match evidence', async () => {
    const github = {
      listRecentCommits: jest.fn().mockResolvedValue([
        {
          sha: 'abc1234',
          message: 'fix angelone integration',
          authorName: 'Jane Dev',
        },
        { sha: 'def5678', message: '', authorName: '' },
      ]),
      getCommitPatch: jest.fn().mockResolvedValue([]),
    };
    const service = buildService(github);

    const ctx = await service.appendHistoricalSecretSignals(
      'owner',
      'repo',
      'main',
      {
        fullName: 'owner/repo',
        owner: 'owner',
        name: 'repo',
        description: '',
        topics: [],
        language: '',
        stars: 0,
        forks: 0,
        isFork: false,
        filePaths: [],
        readmeText: '',
        smallFileTexts: [],
      },
    );

    expect(ctx.commitMessages).toEqual(['fix angelone integration']);
    expect(ctx.commitAuthors).toEqual(['Jane Dev']);
  });

  it('leaves ctx unchanged if the commit fetch fails', async () => {
    const github = {
      listRecentCommits: jest.fn().mockRejectedValue(new Error('rate limited')),
      getCommitPatch: jest.fn(),
    };
    const service = buildService(github);

    const ctx = await service.appendHistoricalSecretSignals(
      'owner',
      'repo',
      'main',
      {
        fullName: 'owner/repo',
        owner: 'owner',
        name: 'repo',
        description: '',
        topics: [],
        language: '',
        stars: 0,
        forks: 0,
        isFork: false,
        filePaths: [],
        readmeText: '',
        smallFileTexts: [],
      },
    );

    expect(ctx.commitMessages).toBeUndefined();
    expect(ctx.smallFileTexts).toEqual([]);
  });
});

describe('ScanPipelineService.upsertRepository', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const item = {
    id: 555,
    full_name: 'evil/zerodha-clone',
    html_url: 'https://github.com/evil/zerodha-clone',
    description: 'fake',
    stargazers_count: 0,
    forks_count: 0,
    fork: false,
    language: 'Python',
    topics: [],
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-02T00:00:00Z',
    pushed_at: '2023-01-02T00:00:00Z',
    owner: { login: 'evil' },
    name: 'zerodha-clone',
  };

  function buildServiceWithRepoModel(repoModel: unknown) {
    return new ScanPipelineService(
      repoModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
  }

  it('discoveredOnly=true records the repo as a candidate without touching analysis-outcome fields', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({});
    const service = buildServiceWithRepoModel({ findOneAndUpdate });

    await service.upsertRepository(workspaceId, item, {
      discoveredOnly: true,
    });

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update] = findOneAndUpdate.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(update.pendingAnalysis).toBe(true);
    expect(update.lastScannedAt).toBeUndefined();
    expect(update.lastSuccessfulScanAt).toBeUndefined();
    expect(update.fullName).toBe('evil/zerodha-clone');
  });

  it('a real (non-discoveredOnly) analysis pass clears pendingAnalysis back to false', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({});
    const service = buildServiceWithRepoModel({ findOneAndUpdate });

    await service.upsertRepository(workspaceId, item, {});

    const [, update] = findOneAndUpdate.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(update.pendingAnalysis).toBe(false);
    expect(update.lastScannedAt).toBeInstanceOf(Date);
  });
});

describe('ScanPipelineService.clearPendingAnalysis', () => {
  it('touches only pendingAnalysis, never defaultBranch/lastScannedAt/lastProcessedCommitSha - see BranchAnalysisProcessor', async () => {
    const workspaceId = new Types.ObjectId().toHexString();
    const repositoryDbId = new Types.ObjectId().toHexString();
    const updateOne = jest.fn().mockResolvedValue({});
    const service = new ScanPipelineService(
      { updateOne } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );

    await service.clearPendingAnalysis(workspaceId, repositoryDbId);

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(String(filter._id)).toBe(repositoryDbId);
    expect(String(filter.workspaceId)).toBe(workspaceId);
    expect(update.$set).toEqual({ pendingAnalysis: false });
  });
});
