import { createHash } from 'crypto';
import { Types } from 'mongoose';
import {
  FindingStatus,
  ScanJobStatus,
  Severity,
  ThreatCategory,
} from '../common/enums';
import { ScanStateService } from '../scans/scan-state.service';
import { ScanPipelineService } from '../scans/scan-pipeline.service';
import { DetectionEngine } from '../detection/detection.engine';
import { RiskScoringService } from '../detection/risk-scoring.service';

function hashOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('ScanStateService finalization', () => {
  it('marks partially_completed when some repos failed', async () => {
    const doc = {
      status: ScanJobStatus.RUNNING,
      cancelRequested: false,
      reposFailed: 2,
      reposProcessed: 5,
      awaitingSearch: 0,
      awaitingAnalysis: 0,
      save: jest.fn(),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(doc),
      }),
    };
    const progress = {
      emitFromScanId: jest.fn().mockResolvedValue(null),
    };
    const scanQueue = { enqueueManualScan: jest.fn().mockResolvedValue({}) };
    const service = new ScanStateService(
      scanModel as never,
      progress as never,
      scanQueue as never,
    );
    const result = await service.finalize(new Types.ObjectId().toHexString());
    expect(result?.status).toBe(ScanJobStatus.PARTIALLY_COMPLETED);
    expect(progress.emitFromScanId).toHaveBeenCalled();
  });

  it('marks cancelled when cancelRequested', async () => {
    const doc = {
      status: ScanJobStatus.RUNNING,
      cancelRequested: true,
      reposFailed: 0,
      reposProcessed: 1,
      save: jest.fn(),
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(doc),
      }),
    };
    const progress = {
      emitFromScanId: jest.fn().mockResolvedValue(null),
    };
    const scanQueue = { enqueueManualScan: jest.fn().mockResolvedValue({}) };
    const service = new ScanStateService(
      scanModel as never,
      progress as never,
      scanQueue as never,
    );
    const result = await service.finalize(new Types.ObjectId().toHexString());
    expect(result?.status).toBe(ScanJobStatus.CANCELLED);
  });
});

describe('ScanPipelineService detection with mocked content', () => {
  it('detects secrets from mocked repository text without live GitHub', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((doc: Record<string, unknown>) =>
        Promise.resolve({
          _id: new Types.ObjectId(),
          ...doc,
        }),
      ),
      find: jest.fn().mockReturnValue({
        exec: () => Promise.resolve([]),
      }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    const result = await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/phonepe-apk',
      brandName: 'PhonePe',
      ctx: {
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
      },
    });

    expect(result.created).toBe(1);
    expect(findingModel.create).toHaveBeenCalled();
    const createCalls = findingModel.create.mock.calls as Array<
      [{ categories: ThreatCategory[]; severity: Severity; origin: string }]
    >;
    const created = createCalls[0][0];
    expect(created.categories.length).toBeGreaterThan(0);
    const allowed = new Set<ThreatCategory>([
      ThreatCategory.EXPOSED_SECRET,
      ThreatCategory.PHISHING,
      ThreatCategory.FAKE_APK,
      ThreatCategory.BRAND_IMPERSONATION,
    ]);
    expect(created.categories.some((c) => allowed.has(c))).toBe(true);
    expect(created.origin).toBe('external');
  });

  it('marks a finding origin "internal" and drops impersonation-only detections when internalAudit is true', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 77,
      fullName: 'acme-corp/internal-tool',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'AngelOne',
      internalAudit: true,
      ctx: {
        fullName: 'acme-corp/internal-tool',
        owner: 'acme-corp',
        name: 'internal-tool',
        description: 'AngelOne login portal - AKIAIOSFODNN7EXAMPLE',
        topics: [],
        language: 'Java',
        stars: 0,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['app.apk', 'README.md'],
        readmeText: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
        smallFileTexts: [],
        matchedBrandName: 'AngelOne',
        matchedBrandAliases: ['angelone'],
        matchedBrandTrustedOwners: ['acme-corp'],
      },
    });

    expect(findingModel.create).toHaveBeenCalled();
    const created = (
      findingModel.create.mock.calls[0] as [{ origin: string }]
    )[0];
    expect(created.origin).toBe('internal');

    const inserted = (
      detectionModel.insertMany.mock.calls[0] as [Array<{ ruleId: string }>]
    )[0];
    expect(inserted.some((d) => d.ruleId === 'brand-impersonation')).toBe(
      false,
    );
    expect(inserted.some((d) => d.ruleId.startsWith('secret-'))).toBe(true);
  });

  it('attaches the exact file/line to a brand-impersonation detection when the brand was only found via a deep full-repo grep hit', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 99,
      fullName: 'someone/generic-trading-tool',
      brandName: 'PhonePe',
      ctx: {
        fullName: 'someone/generic-trading-tool',
        owner: 'someone',
        name: 'generic-trading-tool',
        description: 'A generic internal utility',
        topics: [],
        language: 'Python',
        stars: 5,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['src/deep/scraper.py'],
        readmeText: '',
        smallFileTexts: [],
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe'],
        brandFileMatches: [
          {
            alias: 'phonepe',
            path: 'src/deep/scraper.py',
            lineNumber: 42,
            line: 'phonepe login verify otp bypass here',
          },
        ],
      },
    });

    const insertCalls = detectionModel.insertMany.mock.calls as Array<
      [Array<{ ruleId: string; file?: string; lineNumber?: number }>]
    >;
    const inserted = insertCalls[0][0];
    const brandDetection = inserted.find(
      (d) => d.ruleId === 'brand-impersonation',
    );
    expect(brandDetection?.file).toBe('src/deep/scraper.py');
    expect(brandDetection?.lineNumber).toBe(42);
  });

  it('folds in a repeat-operator signal when the same owner hit other brands', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const otherRepoId = new Types.ObjectId();
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      // Two different queries share this mock: getOperatorContext's (looks
      // up brandName across other repos, via .select().lean()) and
      // resolveMissingFindings' (looks up full open/acknowledged Finding
      // docs for *this* repo, via a plain .exec()) - distinguish by filter
      // shape rather than assuming call order.
      find: jest
        .fn()
        .mockImplementation((filter: { repositoryId?: unknown }) => {
          const isOperatorQuery =
            typeof filter.repositoryId === 'object' &&
            filter.repositoryId !== null &&
            '$in' in (filter.repositoryId as Record<string, unknown>);
          return {
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockReturnThis(),
            exec: () =>
              Promise.resolve(
                isOperatorQuery
                  ? [{ brandName: 'Groww' }, { brandName: 'Zerodha' }]
                  : [],
              ),
          };
        }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([{ _id: otherRepoId }]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/phonepe-apk',
      brandName: 'PhonePe',
      ctx: {
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
      },
    });

    const created = findingModel.create.mock.calls[0][0] as {
      riskBreakdown: Array<{ factor: string; detail: string }>;
    };
    const operatorLine = created.riskBreakdown.find(
      (b) => b.factor === 'Repeat operator pattern',
    );
    expect(operatorLine).toBeDefined();
    expect(operatorLine?.detail).toContain('2 other monitored brands');
  });

  it("persists this repo's own contact fingerprints and scores a cross-owner match", async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const otherRepoId = new Types.ObjectId();
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      // resolveMissingFindings queries by this repo's own (singular)
      // repositoryId; the cross-identity active-findings check queries by
      // a $in list of *other* repos' ids - distinguish by filter shape.
      find: jest
        .fn()
        .mockImplementation((filter: { repositoryId?: unknown }) => {
          const isCrossIdentityQuery =
            typeof filter.repositoryId === 'object' &&
            filter.repositoryId !== null &&
            '$in' in (filter.repositoryId as Record<string, unknown>);
          return {
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockReturnThis(),
            exec: () =>
              Promise.resolve(
                isCrossIdentityQuery ? [{ repositoryId: otherRepoId }] : [],
              ),
          };
        }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const findOneAndUpdate = jest.fn().mockResolvedValue(undefined);
    const fingerprintFind = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve([{ owner: 'someone-else', repositoryId: otherRepoId }]),
    });
    const fingerprintModel = {
      findOneAndUpdate,
      deleteMany: jest.fn(),
      find: fingerprintFind,
    };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/phonepe-apk',
      brandName: 'PhonePe',
      ctx: {
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
        readmeText:
          'phishing kit\nAWS_KEY=AKIAIOSFODNN7EXAMPLE\nContact: scammer@protonmail.com',
        smallFileTexts: [],
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe'],
      },
    });

    // The extracted email fingerprint gets upserted for this repo.
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'email',
        value: 'scammer@protonmail.com',
      }),
      expect.anything(),
      expect.objectContaining({ upsert: true }),
    );

    const created = findingModel.create.mock.calls[0][0] as {
      riskBreakdown: Array<{ factor: string; detail: string }>;
    };
    const linkedLine = created.riskBreakdown.find(
      (b) => b.factor === 'Linked to other GitHub identities',
    );
    expect(linkedLine).toBeDefined();
    expect(linkedLine?.detail).toContain('1 other GitHub account');
  });

  it('attaches brandMatchEvidence showing exactly where the brand was found', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'angel-one-tech/backend-services',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'AngelOne',
      ctx: {
        fullName: 'angel-one-tech/backend-services',
        owner: 'angel-one-tech',
        name: 'backend-services',
        description: 'Internal services monorepo',
        topics: [],
        language: 'TypeScript',
        stars: 5000,
        forks: 200,
        isFork: false,
        githubCreatedAt: new Date('2018-01-01'),
        filePaths: ['config/.env'],
        readmeText: '',
        smallFileTexts: [
          { path: 'config/.env', content: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE' },
        ],
        matchedBrandName: 'AngelOne',
        matchedBrandAliases: ['angelone'],
        matchedBrandTrustedOwners: ['angel-one-tech'],
      },
    });

    const created = findingModel.create.mock.calls[0][0] as {
      brandMatchEvidence?: { type: string; location: string };
    };
    expect(created.brandMatchEvidence).toEqual({
      type: 'trusted_owner',
      location: 'owner',
      matchedAlias: 'angel-one-tech',
      matchedText: 'angel-one-tech',
    });
  });

  it('does not reopen a finding an analyst marked false_positive', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const existing = {
      status: FindingStatus.FALSE_POSITIVE,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(existing),
      find: jest.fn().mockReturnValue({
        exec: () => Promise.resolve([]),
      }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    const result = await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/phonepe-apk',
      brandName: 'PhonePe',
      ctx: {
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
      },
    });

    expect(existing.status).toBe(FindingStatus.FALSE_POSITIVE);
    expect(result.findingsReopened).toBe(0);
    expect(result.shouldAlert).toBe(false);
    expect(existing.save).toHaveBeenCalled();
  });

  it('never deletes old detections when re-inserting fails for an existing finding', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const existing = {
      _id: new Types.ObjectId(),
      status: FindingStatus.OPEN,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(existing),
      find: jest.fn().mockReturnValue({
        exec: () => Promise.resolve([]),
      }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      // Simulates a transient Mongo failure on the write.
      insertMany: jest.fn().mockRejectedValue(new Error('write failed')),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await expect(
      pipeline.runDetectionAndPersist({
        workspaceId: new Types.ObjectId().toHexString(),
        scanJobId: new Types.ObjectId().toHexString(),
        repositoryDbId: new Types.ObjectId().toHexString(),
        githubId: 42,
        fullName: 'evil/phonepe-apk',
        brandName: 'PhonePe',
        ctx: {
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
        },
      }),
    ).rejects.toThrow('write failed');

    // The finding's metadata may already be saved by this point, but its
    // old detections must survive an insert failure - deleteMany must
    // never run before insertMany has actually succeeded.
    expect(detectionModel.deleteMany).not.toHaveBeenCalled();
  });

  it('adds a CRITICAL credential-reuse detection when a found secret matches a known client secret hash', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const rawKey = 'AKIAIOSFODNN7EXAMPLE';
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };
    const knownSecretModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([{ valueHash: hashOf(rawKey) }]),
      }),
    };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
      knownSecretModel as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/clone-of-our-backend',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'PhonePe',
      ctx: {
        fullName: 'evil/clone-of-our-backend',
        owner: 'evil',
        name: 'clone-of-our-backend',
        description: '',
        topics: [],
        language: 'JavaScript',
        stars: 0,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['.env'],
        readmeText: '',
        smallFileTexts: [
          { path: '.env', content: `AWS_ACCESS_KEY_ID=${rawKey}` },
        ],
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe'],
      },
    });

    expect(knownSecretModel.find).toHaveBeenCalled();
    const created = findingModel.create.mock.calls[0][0] as {
      categories: ThreatCategory[];
      severity: Severity;
    };
    expect(created.categories).toContain(ThreatCategory.CREDENTIAL_REUSE);
    expect(created.severity).toBe(Severity.CRITICAL);

    const inserted = (
      detectionModel.insertMany.mock.calls[0] as [Array<{ ruleId: string }>]
    )[0];
    expect(inserted.some((d) => d.ruleId === 'credential-reuse')).toBe(true);
  });

  it('never performs the credential-reuse lookup during an internal audit', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const rawKey = 'AKIAIOSFODNN7EXAMPLE';
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };
    const knownSecretModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([{ valueHash: hashOf(rawKey) }]),
      }),
    };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
      knownSecretModel as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'acme-corp/internal-tool',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'PhonePe',
      internalAudit: true,
      ctx: {
        fullName: 'acme-corp/internal-tool',
        owner: 'acme-corp',
        name: 'internal-tool',
        description: '',
        topics: [],
        language: 'JavaScript',
        stars: 0,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['.env'],
        readmeText: '',
        smallFileTexts: [
          { path: '.env', content: `AWS_ACCESS_KEY_ID=${rawKey}` },
        ],
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe'],
        matchedBrandTrustedOwners: ['acme-corp'],
      },
    });

    expect(knownSecretModel.find).not.toHaveBeenCalled();
    const created = findingModel.create.mock.calls[0][0] as {
      categories: ThreatCategory[];
    };
    expect(created.categories).not.toContain(ThreatCategory.CREDENTIAL_REUSE);
  });

  it('adds a content-reuse detection when a stored brand phrase is found verbatim in the repo', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const phrase = 'Track your shipment in real time with Acme Express';
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };
    const knownSecretModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const contentStringModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([{ text: phrase }]),
      }),
    };
    const codeFingerprintModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
      knownSecretModel as never,
      contentStringModel as never,
      codeFingerprintModel as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/clone-of-our-site',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'PhonePe',
      ctx: {
        fullName: 'evil/clone-of-our-site',
        owner: 'evil',
        name: 'clone-of-our-site',
        description: '',
        topics: [],
        language: 'JavaScript',
        stars: 0,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['src/locales/en.json'],
        readmeText: '',
        smallFileTexts: [{ path: 'src/locales/en.json', content: phrase }],
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe'],
      },
    });

    expect(contentStringModel.find).toHaveBeenCalled();
    const created = findingModel.create.mock.calls[0][0] as {
      categories: ThreatCategory[];
      severity: Severity;
    };
    expect(created.categories).toContain(ThreatCategory.CONTENT_REUSE);

    const inserted = (
      detectionModel.insertMany.mock.calls[0] as [Array<{ ruleId: string }>]
    )[0];
    expect(inserted.some((d) => d.ruleId === 'content-reuse-phrase')).toBe(
      true,
    );
  });

  it('adds a CRITICAL content-reuse detection when a repo file is byte-identical to a reference file', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const fileContent = 'y'.repeat(500);
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };
    const knownSecretModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const contentStringModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const codeFingerprintModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([{ contentHash: hashOf(fileContent) }]),
      }),
    };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
      knownSecretModel as never,
      contentStringModel as never,
      codeFingerprintModel as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 42,
      fullName: 'evil/clone-of-our-site',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'PhonePe',
      ctx: {
        fullName: 'evil/clone-of-our-site',
        owner: 'evil',
        name: 'clone-of-our-site',
        description: '',
        topics: [],
        language: 'JavaScript',
        stars: 0,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['src/templates/receipt.html'],
        readmeText: '',
        smallFileTexts: [
          { path: 'src/templates/receipt.html', content: fileContent },
        ],
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe'],
      },
    });

    const created = findingModel.create.mock.calls[0][0] as {
      categories: ThreatCategory[];
    };
    expect(created.categories).toContain(ThreatCategory.CONTENT_REUSE);

    // The individual detection is CRITICAL severity by design (an exact
    // byte-for-byte file match is near-certain evidence) - the finding's
    // own aggregate severity is a separate, total-risk-score computation
    // (see risk-scoring.service.ts) that a single moderate-weight detection
    // alone won't necessarily push into the critical bucket.
    const inserted = (
      detectionModel.insertMany.mock.calls[0] as [
        Array<{ ruleId: string; severity: string }>,
      ]
    )[0];
    const fileDetection = inserted.find(
      (d) => d.ruleId === 'content-reuse-file',
    );
    expect(fileDetection?.severity).toBe(Severity.CRITICAL);
  });

  it('sets keywordMatchCount to the number of distinct curated keywords matched, on a new finding', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((doc: Record<string, unknown>) =>
          Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
        ),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 99,
      fullName: 'evil/zerodha-fraud-kit',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'Zerodha',
      ctx: {
        fullName: 'evil/zerodha-fraud-kit',
        owner: 'evil',
        name: 'zerodha-fraud-kit',
        description: '',
        topics: [],
        language: 'JavaScript',
        stars: 0,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['README.md'],
        readmeText: 'zerodha otp bypass tool with kyc fraud automation',
        smallFileTexts: [],
        matchedBrandName: 'Zerodha',
        matchedBrandAliases: ['zerodha'],
        matchedBrandKeywords: ['otp bypass', 'kyc fraud'],
      },
    });

    const inserted = (
      detectionModel.insertMany.mock.calls[0] as [Array<{ ruleId: string }>]
    )[0];
    const keywordDetections = inserted.filter(
      (d) => d.ruleId === 'custom-keyword-match',
    );
    expect(keywordDetections).toHaveLength(2);

    const created = findingModel.create.mock.calls[0][0] as {
      keywordMatchCount: number;
    };
    expect(created.keywordMatchCount).toBe(2);
  });

  it('updates keywordMatchCount on an existing finding to match the current scan (not the count from when it was first created)', async () => {
    const engine = new DetectionEngine();
    const scoring = new RiskScoringService();
    const existing = {
      status: FindingStatus.OPEN,
      keywordMatchCount: 1,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const findingModel = {
      findOne: jest.fn().mockResolvedValue(existing),
      find: jest.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    const detectionModel = {
      deleteMany: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: () => Promise.resolve([]),
      }),
    };
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
      getRepositoryPagesInfo: jest.fn().mockResolvedValue(null),
    };
    const fingerprintModel = { deleteMany: jest.fn(), find: jest.fn() };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
      { shouldAttempt: () => Promise.resolve(false) } as never,
    );

    await pipeline.runDetectionAndPersist({
      workspaceId: new Types.ObjectId().toHexString(),
      scanJobId: new Types.ObjectId().toHexString(),
      repositoryDbId: new Types.ObjectId().toHexString(),
      githubId: 100,
      fullName: 'evil/zerodha-fraud-kit',
      brandId: new Types.ObjectId().toHexString(),
      brandName: 'Zerodha',
      ctx: {
        fullName: 'evil/zerodha-fraud-kit',
        owner: 'evil',
        name: 'zerodha-fraud-kit',
        description: '',
        topics: [],
        language: 'JavaScript',
        stars: 0,
        forks: 0,
        isFork: false,
        githubCreatedAt: new Date(),
        filePaths: ['README.md'],
        readmeText: 'zerodha otp bypass tool with kyc fraud automation',
        smallFileTexts: [],
        matchedBrandName: 'Zerodha',
        matchedBrandAliases: ['zerodha'],
        matchedBrandKeywords: ['otp bypass', 'kyc fraud'],
      },
    });

    expect(existing.keywordMatchCount).toBe(2);
  });
});
