import { Types } from 'mongoose';
import { IntelligenceService } from './intelligence.service';
import { RepositoryIntent } from './schemas/intent-assessment.schema';
import {
  IntentContext,
  IntentResult,
} from './providers/intent-provider.interface';
import { computeContextHash } from './context-hash';
import { PROMPT_VERSION } from './intent-prompt';

const workspaceId = new Types.ObjectId().toHexString();
const repositoryId = new Types.ObjectId().toHexString();
const findingId = new Types.ObjectId().toHexString();

const sampleContext: IntentContext = {
  repository: {
    fullName: 'evil/zerodha-clone',
    owner: 'evil',
    description: '',
    topics: [],
    language: 'Python',
    stars: 0,
    forks: 0,
    isFork: false,
    otherReposByOwnerInWorkspace: 0,
  },
  finding: {
    severity: 'critical',
    riskScore: 100,
    categories: ['fake_apk'],
    origin: 'external',
  },
  detections: [],
  operatorSignals: { otherBrandsHit: 0, linkedIdentityOwners: 0 },
  contributors: { count: 0, overlapWithOtherRepos: 0 },
  credentials: [],
  trustSignals: { isTrustedOwner: false },
};

function baseResult(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intent: 'benign',
    riskScore: 15,
    confidence: 0.85,
    reasoning: 'Looks like a legitimate stock screener.',
    signalsUsed: ['fake-apk'],
    factors: [],
    missingInformation: [],
    needsDeepReview: false,
    model: 'gemini-3.6-flash',
    ...overrides,
  };
}

function chainable(resolved: unknown) {
  return {
    sort: jest
      .fn()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue(resolved) }),
  };
}

function buildService(
  overrides: {
    geminiConfigured?: boolean;
    geminiResult?: 'success' | 'error';
    geminiResultValue?: Partial<IntentResult>;
    openrouterConfigured?: boolean;
    openrouterResult?: 'success' | 'error';
    existingAssessment?: unknown;
  } = {},
) {
  const assessmentCreate = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({
        _id: new Types.ObjectId(),
        save: jest.fn().mockResolvedValue(undefined),
        ...doc,
      }),
    );
  const assessmentFindOne = jest
    .fn()
    .mockReturnValue(chainable(overrides.existingAssessment ?? null));
  const assessmentModel = {
    create: assessmentCreate,
    findOne: assessmentFindOne,
  };

  const findingUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });
  const findingModel = { updateOne: findingUpdateOne };

  const detectionFind = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
    }),
  });
  const detectionModel = { find: detectionFind };

  const contextBuilder = { build: jest.fn().mockResolvedValue(sampleContext) };
  const deepContextBuilder = {
    build: jest.fn().mockResolvedValue({ flaggedFiles: [] }),
  };

  const gemini = {
    name: 'gemini',
    isConfigured: () => overrides.geminiConfigured ?? true,
    assess:
      overrides.geminiResult === 'error'
        ? jest.fn().mockRejectedValue(new Error('gemini boom'))
        : jest.fn().mockResolvedValue(baseResult(overrides.geminiResultValue)),
  };

  const openrouter = {
    name: 'openrouter',
    isConfigured: () => overrides.openrouterConfigured ?? false,
    assess:
      overrides.openrouterResult === 'error'
        ? jest.fn().mockRejectedValue(new Error('openrouter boom'))
        : jest.fn().mockResolvedValue(
            baseResult({
              intent: 'malicious_operation',
              riskScore: 90,
              confidence: 0.7,
              reasoning: 'Fallback verdict.',
              signalsUsed: [],
              model: 'some-free-model',
            }),
          ),
  };

  const config = { get: jest.fn().mockReturnValue(undefined) };

  const service = new IntelligenceService(
    assessmentModel as never,
    findingModel as never,
    detectionModel as never,
    contextBuilder as never,
    deepContextBuilder as never,
    gemini as never,
    openrouter as never,
    config as never,
  );

  return {
    service,
    assessmentCreate,
    assessmentFindOne,
    findingUpdateOne,
    contextBuilder,
    deepContextBuilder,
    gemini,
    openrouter,
  };
}

describe('IntelligenceService.assess', () => {
  it('returns null and never calls a provider when nothing is configured', async () => {
    const { service, assessmentCreate } = buildService({
      geminiConfigured: false,
    });
    const result = await service.assess(workspaceId, repositoryId, findingId);
    expect(result).toBeNull();
    expect(assessmentCreate).not.toHaveBeenCalled();
  });

  it('returns null without calling any provider when the repository/finding context cannot be built', async () => {
    const { service, contextBuilder, assessmentCreate } = buildService();
    contextBuilder.build.mockResolvedValue(null);
    const result = await service.assess(workspaceId, repositoryId, findingId);
    expect(result).toBeNull();
    expect(assessmentCreate).not.toHaveBeenCalled();
  });

  it('persists a completed Tier-1 assessment and overwrites the finding riskScore/severity/scoringSource/latestIntent on success', async () => {
    const { service, findingUpdateOne } = buildService();
    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(result).toMatchObject({
      status: 'completed',
      tier: 'first',
      provider: 'gemini',
      intent: 'benign',
      riskScore: 15,
      confidence: 0.85,
    });

    expect(findingUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = findingUpdateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(String(filter._id)).toBe(findingId);
    // 15 is well under the 40-point MEDIUM floor - severityFromScore(15) must be 'low'.
    expect(update.$set).toMatchObject({
      riskScore: 15,
      severity: 'low',
      scoringSource: 'ai',
      latestIntent: 'benign',
      needsDeepReview: false,
    });
  });

  it('falls back to OpenRouter when Gemini fails, and still overwrites the finding', async () => {
    const { service, findingUpdateOne } = buildService({
      geminiResult: 'error',
      openrouterConfigured: true,
    });
    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(result).toMatchObject({
      status: 'completed',
      provider: 'openrouter',
      riskScore: 90,
    });
    expect(findingUpdateOne).toHaveBeenCalledTimes(1);
    const [, update] = findingUpdateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    // 90 clears the 85-point CRITICAL floor.
    expect(update.$set).toMatchObject({
      riskScore: 90,
      severity: 'critical',
      scoringSource: 'ai',
    });
  });

  it('persists a failed assessment and leaves the finding untouched when every configured provider errors', async () => {
    const { service, findingUpdateOne, assessmentCreate } = buildService({
      geminiResult: 'error',
      openrouterConfigured: true,
      openrouterResult: 'error',
    });
    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(result).toMatchObject({
      status: 'failed',
      intent: RepositoryIntent.INCONCLUSIVE,
    });
    expect(assessmentCreate).toHaveBeenCalledTimes(1);
    const [createArg] = assessmentCreate.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(createArg).toMatchObject({
      status: 'failed',
      intent: RepositoryIntent.INCONCLUSIVE,
      provider: 'openrouter',
    });
    expect(findingUpdateOne).not.toHaveBeenCalled();
  });

  it('skips the LLM call entirely when a completed assessment already exists for the same finding + contextHash', async () => {
    const contextHash = computeContextHash(sampleContext, PROMPT_VERSION);
    const existing = {
      _id: new Types.ObjectId(),
      status: 'completed',
      contextHash,
    };
    const { service, gemini, openrouter, assessmentCreate } = buildService({
      existingAssessment: existing,
    });

    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(result).toBe(existing);
    expect(gemini.assess).not.toHaveBeenCalled();
    expect(openrouter.assess).not.toHaveBeenCalled();
    expect(assessmentCreate).not.toHaveBeenCalled();
  });

  it('calls the provider again when the context has changed (different contextHash)', async () => {
    const { service, contextBuilder, gemini } = buildService();
    contextBuilder.build.mockResolvedValueOnce(sampleContext);
    const changedContext = {
      ...sampleContext,
      finding: { ...sampleContext.finding, riskScore: 55 },
    };
    contextBuilder.build.mockResolvedValueOnce(changedContext);

    await service.assess(workspaceId, repositoryId, findingId);
    await service.assess(workspaceId, repositoryId, findingId);

    expect(gemini.assess).toHaveBeenCalledTimes(2);
  });

  it('runs a Tier-2 deep review when Tier-1 confidence is below the threshold', async () => {
    const { service, deepContextBuilder, gemini } = buildService({
      geminiResultValue: { confidence: 0.2, intent: 'inconclusive' },
    });

    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(deepContextBuilder.build).toHaveBeenCalledTimes(1);
    expect(gemini.assess).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ tier: 'deep' });
  });

  it('does not run a deep review when Tier-1 is confident and conclusive', async () => {
    const { service, deepContextBuilder, gemini } = buildService();

    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(deepContextBuilder.build).not.toHaveBeenCalled();
    expect(gemini.assess).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ tier: 'first' });
  });

  it('strips an evidence citation that does not correspond to anything in the supplied context, and downgrades confidence', async () => {
    const { service, assessmentCreate } = buildService({
      geminiResultValue: {
        factors: [
          {
            factor: 'Suspicious file found',
            direction: 'supports_malicious',
            evidenceReferences: ['totally-fabricated-file-xyz.js'],
          },
        ],
      },
    });

    await service.assess(workspaceId, repositoryId, findingId);

    const [createArg] = assessmentCreate.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(createArg.factors).toEqual([
      expect.objectContaining({ evidenceReferences: [] }),
    ]);
    // 0.85 * 0.7 = 0.595, rounded to 0.6
    expect(createArg.confidence).toBeCloseTo(0.6, 5);
  });

  it('leaves the Finding at its Tier-1 values when the Tier-2 provider call throws', async () => {
    const { service, findingUpdateOne, assessmentCreate, gemini } =
      buildService({
        geminiResultValue: { confidence: 0.1, intent: 'inconclusive' },
      });
    gemini.assess
      .mockResolvedValueOnce(
        baseResult({ confidence: 0.1, intent: 'inconclusive' }),
      )
      .mockRejectedValueOnce(new Error('deep review boom'));

    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(result).toMatchObject({ tier: 'first', intent: 'inconclusive' });
    // Finding was overwritten once, for Tier 1 only - the failed Tier-2
    // attempt never got a second chance to overwrite it.
    expect(findingUpdateOne).toHaveBeenCalledTimes(1);
    // Assessments persisted: the Tier-1 completed row, plus a Tier-2
    // failed row for visibility.
    expect(assessmentCreate).toHaveBeenCalledTimes(2);
    const persistedTiers = (
      assessmentCreate.mock.calls as Array<[Record<string, unknown>]>
    ).map(([doc]) => doc.tier);
    expect(persistedTiers).toEqual(['first', 'deep']);
    const deepDoc = (
      assessmentCreate.mock.calls[1] as [Record<string, unknown>]
    )[0];
    expect(deepDoc.status).toBe('failed');
  });
});
