import { Types } from 'mongoose';
import { FindingChangeType, FindingStatus, ScanMode } from '../common/enums';
import { DetectionEngine } from '../detection/detection.engine';
import { IncrementalScanService } from './incremental-scan.service';
import { ScanPipelineService } from './scan-pipeline.service';
import { RiskScoringService } from '../detection/risk-scoring.service';

describe('IncrementalScanService.decideRescan', () => {
  const engine = new DetectionEngine();
  const service = new IncrementalScanService({} as never, {} as never, engine);
  const ruleset = engine.getRulesetVersion();
  const sha = 'abc123def456';
  const pushed = new Date('2026-01-01T00:00:00Z');
  const updated = new Date('2026-01-01T00:00:00Z');

  function existing(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      githubId: 42,
      fullName: 'org/repo',
      lastProcessedCommitSha: sha,
      lastSuccessfulScanAt: new Date('2026-01-02T00:00:00Z'),
      lastRulesetVersion: ruleset,
      lastProcessingFailed: false,
      githubPushedAt: pushed,
      githubUpdatedAt: updated,
      ...overrides,
    };
  }

  it('skips content analysis when SHA and ruleset are unchanged', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing() as never,
      commitSha: sha,
      pushedAt: pushed,
      updatedAt: updated,
    });
    expect(decision).toEqual({
      analyze: false,
      reason: 'unchanged',
      commitSha: sha,
    });
  });

  it('rescans when commit SHA changes', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing() as never,
      commitSha: 'new-sha-999',
      pushedAt: pushed,
      updatedAt: updated,
    });
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('sha_changed');
  });

  it('rescans when ruleset version changes', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: false,
      rulesetVersion: 'different-ruleset',
      existing: existing() as never,
      commitSha: sha,
    });
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('ruleset_changed');
  });

  it('rescans when previous processing failed', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing({ lastProcessingFailed: true }) as never,
      commitSha: sha,
    });
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('previous_failed');
  });

  it('rescans when no successful scan exists', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing({ lastSuccessfulScanAt: undefined }) as never,
      commitSha: sha,
    });
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('no_prior_success');
  });

  it('forces full scan when requested', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: true,
      rulesetVersion: ruleset,
      existing: existing() as never,
      commitSha: sha,
    });
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('force_full');
  });

  it('forces full scan in full mode', () => {
    const decision = service.decideRescan({
      mode: ScanMode.FULL,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing() as never,
      commitSha: sha,
    });
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('force_full');
  });

  it('failed_only analyzes only previously failed repos', () => {
    const failed = service.decideRescan({
      mode: ScanMode.FAILED_ONLY,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing({ lastProcessingFailed: true }) as never,
      commitSha: sha,
    });
    const ok = service.decideRescan({
      mode: ScanMode.FAILED_ONLY,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing() as never,
      commitSha: sha,
    });
    expect(failed.analyze).toBe(true);
    expect(failed.reason).toBe('failed_only');
    expect(ok.analyze).toBe(false);
    expect(ok.reason).toBe('unchanged');
  });

  it('treats first-seen repos as needing analysis', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: null,
      commitSha: sha,
    });
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('first_seen');
  });

  it('identity is by githubId — rename of fullName does not affect decision', () => {
    const decision = service.decideRescan({
      mode: ScanMode.INCREMENTAL,
      forceFullScan: false,
      rulesetVersion: ruleset,
      existing: existing({ fullName: 'org/renamed-repo' }) as never,
      commitSha: sha,
      pushedAt: pushed,
      updatedAt: updated,
    });
    expect(decision.analyze).toBe(false);
    expect(decision.reason).toBe('unchanged');
  });
});

describe('IncrementalScanService checkpoints', () => {
  it('persists search cursors and completed github IDs', async () => {
    const scanId = new Types.ObjectId().toHexString();
    const doc = {
      checkpoint: {
        stage: 'queued',
        searchCursors: {},
        completedGithubIds: [],
        skippedGithubIds: [],
        failedGithubIds: [],
        pendingGithubIds: [],
      },
      save: jest.fn().mockResolvedValue(undefined),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(doc),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const service = new IncrementalScanService(
      scanModel as never,
      {} as never,
      new DetectionEngine(),
    );

    await service.saveCheckpoint(scanId, {
      stage: 'search' as never,
      searchCursors: { '0': 2 },
    });
    expect(doc.checkpoint.searchCursors).toEqual({ '0': 2 });
    expect(doc.save).toHaveBeenCalled();

    await service.markGithubCompleted(scanId, 99);
    expect(scanModel.findByIdAndUpdate).toHaveBeenCalledWith(
      scanId,
      expect.objectContaining({
        $addToSet: { 'checkpoint.completedGithubIds': 99 },
      }),
    );
  });

  it('isAlreadyCompleted returns true for checkpointed githubIds', async () => {
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                checkpoint: { completedGithubIds: [7, 8, 9] },
              }),
          }),
        }),
      }),
    };
    const service = new IncrementalScanService(
      scanModel as never,
      {} as never,
      new DetectionEngine(),
    );
    expect(await service.isAlreadyCompleted('scan', 8)).toBe(true);
    expect(await service.isAlreadyCompleted('scan', 1)).toBe(false);
  });

  describe('claimRepositoryForAnalysis', () => {
    it('returns true and calls findOneAndUpdate when repo is unclaimed and limit is not exceeded', async () => {
      const scanModel = {
        findById: jest.fn().mockReturnValue({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                checkpoint: {
                  completedGithubIds: [1, 2],
                  skippedGithubIds: [],
                  failedGithubIds: [],
                  pendingGithubIds: [3],
                },
              }),
          }),
        }),
        findOneAndUpdate: jest.fn().mockReturnValue({
          lean: () => ({
            exec: () => Promise.resolve({ _id: 'scan' }),
          }),
        }),
      };
      const service = new IncrementalScanService(
        scanModel as never,
        {} as never,
        new DetectionEngine(),
      );

      const result = await service.claimRepositoryForAnalysis('scan', 4, 10);
      expect(result).toBe(true);
      expect(scanModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'scan' }),
        expect.objectContaining({
          $addToSet: { 'checkpoint.pendingGithubIds': 4 },
        }),
        expect.any(Object),
      );
    });

    it('returns false when repo is already completed, skipped, failed, or pending', async () => {
      const scanModel = {
        findById: jest.fn().mockReturnValue({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                checkpoint: {
                  completedGithubIds: [1],
                  skippedGithubIds: [2],
                  failedGithubIds: [3],
                  pendingGithubIds: [4],
                },
              }),
          }),
        }),
        findOneAndUpdate: jest.fn(),
      };
      const service = new IncrementalScanService(
        scanModel as never,
        {} as never,
        new DetectionEngine(),
      );

      expect(await service.claimRepositoryForAnalysis('scan', 1, 10)).toBe(
        false,
      );
      expect(await service.claimRepositoryForAnalysis('scan', 2, 10)).toBe(
        false,
      );
      expect(await service.claimRepositoryForAnalysis('scan', 3, 10)).toBe(
        false,
      );
      expect(await service.claimRepositoryForAnalysis('scan', 4, 10)).toBe(
        false,
      );
      expect(scanModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('returns false when limit is exceeded', async () => {
      const scanModel = {
        findById: jest.fn().mockReturnValue({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                checkpoint: {
                  completedGithubIds: [1, 2],
                  skippedGithubIds: [],
                  failedGithubIds: [],
                  pendingGithubIds: [3],
                },
              }),
          }),
        }),
        findOneAndUpdate: jest.fn(),
      };
      const service = new IncrementalScanService(
        scanModel as never,
        {} as never,
        new DetectionEngine(),
      );

      const result = await service.claimRepositoryForAnalysis('scan', 4, 3);
      expect(result).toBe(false);
      expect(scanModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});

describe('IncrementalScanService.recordAdditionalBrandMatch', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const brandId = new Types.ObjectId().toHexString();

  function buildService() {
    const repoModel = {
      updateOne: jest.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
    };
    const service = new IncrementalScanService(
      {} as never,
      repoModel as never,
      new DetectionEngine(),
    );
    return { service, repoModel };
  }

  it('pushes a new entry, excluding repos where this brand is already the primary discoverer or already recorded', async () => {
    const { service, repoModel } = buildService();

    await service.recordAdditionalBrandMatch(workspaceId, 42, {
      brandId,
      keyword: 'groww',
      matchedField: 'description',
      matchedPath: '',
      matchedText: 'mentions groww and motilal oswal',
    });

    expect(repoModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.any(Types.ObjectId) as Types.ObjectId,
        githubId: 42,
        discoveryBrandId: { $ne: new Types.ObjectId(brandId) },
        'additionalBrandMatches.brandId': { $ne: new Types.ObjectId(brandId) },
      }),
      expect.objectContaining({
        $push: {
          additionalBrandMatches: expect.objectContaining({
            brandId: new Types.ObjectId(brandId),
            keyword: 'groww',
            matchedField: 'description',
            matchedText: 'mentions groww and motilal oswal',
          }) as Record<string, unknown>,
        },
      }),
    );
  });

  it('defaults missing evidence fields to empty strings rather than undefined', async () => {
    const { service, repoModel } = buildService();

    await service.recordAdditionalBrandMatch(workspaceId, 42, { brandId });

    const [, update] = repoModel.updateOne.mock.calls[0] as [
      unknown,
      { $push: { additionalBrandMatches: Record<string, unknown> } },
    ];
    expect(update.$push.additionalBrandMatches.matchedField).toBe('');
    expect(update.$push.additionalBrandMatches.matchedPath).toBe('');
    expect(update.$push.additionalBrandMatches.matchedText).toBe('');
  });
});

describe('Finding lifecycle + duplicate prevention', () => {
  function buildPipeline(existingFinding: Record<string, unknown> | null) {
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(
        existingFinding
          ? {
              ...existingFinding,
              save: jest.fn().mockResolvedValue(undefined),
            }
          : null,
      ),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({
        exec: () => Promise.resolve([]),
      }),
    };
    const detectionModel = {
      deleteMany: jest.fn().mockResolvedValue({}),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      { deleteMany: jest.fn(), find: jest.fn() } as never,
      { getRepositoryPagesInfo: jest.fn().mockResolvedValue(null) } as never,
      new DetectionEngine(),
      new RiskScoringService(),
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );
    return { pipeline, findingModel, detectionModel };
  }

  const baseCtx = {
    fullName: 'evil/phonepe-apk',
    owner: 'evil',
    name: 'phonepe-apk',
    description: 'PhonePe login phishing APK mod',
    topics: ['apk', 'phishing'],
    language: 'Java',
    stars: 0,
    forks: 0,
    isFork: false,
    githubCreatedAt: new Date(),
    filePaths: ['app.apk', 'README.md'],
    readmeText: 'phishing kit\nAWS_KEY=AKIAIOSFODNN7EXAMPLE',
    smallFileTexts: [],
    matchedBrandName: 'PhonePe',
    matchedBrandAliases: ['phonepe'],
  };

  it('creates NEW findings on first detection', async () => {
    const { pipeline, findingModel } = buildPipeline(null);
    const result = await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/phonepe-apk',
      brandName: 'PhonePe',
      ctx: baseCtx,
    });
    expect(result.findingsNew).toBe(1);
    expect(result.created).toBe(1);
    expect(findingModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ lastChangeType: FindingChangeType.NEW }),
    );
  });

  it('marks UNCHANGED on resume/retry with same fingerprint (no duplicate)', async () => {
    const { pipeline, findingModel } = buildPipeline({
      status: FindingStatus.OPEN,
      fingerprint: 'will-be-overwritten-by-lookup',
      lastChangeType: FindingChangeType.NEW,
    });
    const result = await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/phonepe-apk',
      brandName: 'PhonePe',
      ctx: baseCtx,
    });
    expect(result.findingsUnchanged).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(findingModel.create).not.toHaveBeenCalled();
  });

  it('marks REOPENED when a resolved finding reappears', async () => {
    const { pipeline } = buildPipeline({
      status: FindingStatus.RESOLVED,
      fingerprint: 'x',
      lastChangeType: FindingChangeType.RESOLVED,
    });
    const result = await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/phonepe-apk',
      brandName: 'PhonePe',
      ctx: baseCtx,
    });
    expect(result.findingsReopened).toBe(1);
    expect(result.updated).toBe(1);
  });

  it('upserts repositories by githubId so renames do not fork identity', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      githubId: 777,
      fullName: 'org/new-name',
    });
    const pipeline = new ScanPipelineService(
      { findOneAndUpdate } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new DetectionEngine(),
      new RiskScoringService(),
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );
    await pipeline.upsertRepository(
      new Types.ObjectId().toHexString(),
      {
        id: 777,
        full_name: 'org/new-name',
        html_url: 'https://github.com/org/new-name',
        description: '',
        stargazers_count: 0,
        forks_count: 0,
        fork: false,
        language: 'TS',
        topics: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        pushed_at: '2026-01-02T00:00:00Z',
        owner: { login: 'org' },
        name: 'new-name',
      },
      { markSuccess: true, commitSha: 'sha1', rulesetVersion: 'r1' },
    );
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ githubId: 777 }),
      expect.objectContaining({
        fullName: 'org/new-name',
        lastProcessedCommitSha: 'sha1',
      }),
      { upsert: true, new: true },
    );
  });
});

/** Before/after metrics demonstrating incremental skip optimization. */
describe('Incremental scan metrics (before/after)', () => {
  it('documents content-analysis savings for unchanged repos', () => {
    const engine = new DetectionEngine();
    const service = new IncrementalScanService(
      {} as never,
      {} as never,
      engine,
    );
    const ruleset = engine.getRulesetVersion();
    const repos = Array.from({ length: 20 }, (_, i) => ({
      githubId: i + 1,
      sha: `sha-${i}`,
      changed: i < 3, // 3 repos changed
    }));

    let contentAnalysesBefore = 0;
    let contentAnalysesAfter = 0;
    let skipped = 0;
    let rescanned = 0;

    for (const repo of repos) {
      // Before: every discovered repo ran full content analysis
      contentAnalysesBefore += 1;

      const decision = service.decideRescan({
        mode: ScanMode.INCREMENTAL,
        forceFullScan: false,
        rulesetVersion: ruleset,
        existing: {
          githubId: repo.githubId,
          lastProcessedCommitSha: repo.sha,
          lastSuccessfulScanAt: new Date(),
          lastRulesetVersion: ruleset,
          lastProcessingFailed: false,
          githubPushedAt: new Date('2026-01-01'),
          githubUpdatedAt: new Date('2026-01-01'),
        } as never,
        commitSha: repo.changed ? `${repo.sha}-new` : repo.sha,
        pushedAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      });

      if (decision.analyze) {
        contentAnalysesAfter += 1;
        rescanned += 1;
      } else {
        skipped += 1;
      }
    }

    expect(contentAnalysesBefore).toBe(20);
    expect(contentAnalysesAfter).toBe(3);
    expect(skipped).toBe(17);
    expect(rescanned).toBe(3);
    // ~85% of content fetches avoided while still rescanning changed SHAs
    expect(skipped / contentAnalysesBefore).toBeGreaterThanOrEqual(0.8);
  });
});
