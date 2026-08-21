import { Types } from 'mongoose';
import { IntelligenceService } from './intelligence.service';
import { RepositoryIntent } from './schemas/intent-assessment.schema';
import { IntentContext } from './providers/intent-provider.interface';

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
};

function buildService(
  overrides: {
    geminiConfigured?: boolean;
    geminiResult?: 'success' | 'error';
    openrouterConfigured?: boolean;
    openrouterResult?: 'success' | 'error';
  } = {},
) {
  const assessmentCreate = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
    );
  const assessmentModel = { create: assessmentCreate };

  const findingUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });
  const findingModel = { updateOne: findingUpdateOne };

  const contextBuilder = { build: jest.fn().mockResolvedValue(sampleContext) };

  const gemini = {
    name: 'gemini',
    isConfigured: () => overrides.geminiConfigured ?? true,
    assess:
      overrides.geminiResult === 'error'
        ? jest.fn().mockRejectedValue(new Error('gemini boom'))
        : jest.fn().mockResolvedValue({
            intent: 'benign',
            riskScore: 15,
            confidence: 0.85,
            reasoning: 'Looks like a legitimate stock screener.',
            signalsUsed: ['fake-apk'],
            model: 'gemini-3.6-flash',
          }),
  };

  const openrouter = {
    name: 'openrouter',
    isConfigured: () => overrides.openrouterConfigured ?? false,
    assess:
      overrides.openrouterResult === 'error'
        ? jest.fn().mockRejectedValue(new Error('openrouter boom'))
        : jest.fn().mockResolvedValue({
            intent: 'malicious_operation',
            riskScore: 90,
            confidence: 0.7,
            reasoning: 'Fallback verdict.',
            signalsUsed: [],
            model: 'some-free-model',
          }),
  };

  const service = new IntelligenceService(
    assessmentModel as never,
    findingModel as never,
    contextBuilder as never,
    gemini as never,
    openrouter as never,
  );

  return { service, assessmentCreate, findingUpdateOne, contextBuilder };
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

  it('persists a completed assessment and overwrites the finding riskScore/severity/scoringSource on success', async () => {
    const { service, findingUpdateOne } = buildService();
    const result = await service.assess(workspaceId, repositoryId, findingId);

    expect(result).toMatchObject({
      status: 'completed',
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
});
