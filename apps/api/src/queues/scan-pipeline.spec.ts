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
    const service = new ScanStateService(scanModel as never, progress as never);
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
    const service = new ScanStateService(scanModel as never, progress as never);
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
    const repoModel = {};
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
    };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
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
      [{ categories: ThreatCategory[]; severity: Severity }]
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
    const repoModel = {};
    const github = {
      listRootPaths: jest.fn(),
      getReadme: jest.fn(),
      getSmallTextFile: jest.fn(),
    };

    const pipeline = new ScanPipelineService(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      github as never,
      engine,
      scoring,
      { get: () => undefined } as never,
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
});
