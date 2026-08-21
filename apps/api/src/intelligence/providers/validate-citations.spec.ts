import { IntentContext } from './intent-provider.interface';
import { ParsedIntentPayload } from './parse-intent-result';
import { validateCitations } from './validate-citations';

const context: IntentContext = {
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
  detections: [
    {
      ruleId: 'fake-apk-distribution',
      category: 'fake_apk',
      severity: 'critical',
      confidence: 0.9,
      evidence: 'Repo distributes an unsigned APK.',
      explanation: 'x',
    },
  ],
  operatorSignals: { otherBrandsHit: 0, linkedIdentityOwners: 0 },
  contributors: { count: 0, overlapWithOtherRepos: 0 },
  credentials: [],
  trustSignals: { isTrustedOwner: false },
};

function payload(
  overrides: Partial<ParsedIntentPayload> = {},
): ParsedIntentPayload {
  return {
    intent: 'malicious_operation',
    riskScore: 90,
    confidence: 0.8,
    reasoning: 'x',
    signalsUsed: [],
    factors: [],
    missingInformation: [],
    needsDeepReview: false,
    ...overrides,
  };
}

describe('validateCitations', () => {
  it('keeps a citation that matches a real detection ruleId untouched, with no confidence change', () => {
    const result = payload({
      factors: [
        {
          factor: 'Distributes malware',
          direction: 'supports_malicious',
          evidenceReferences: ['fake-apk-distribution'],
        },
      ],
    });
    const { result: validated, strippedCount } = validateCitations(
      result,
      context,
    );
    expect(strippedCount).toBe(0);
    expect(validated.factors[0].evidenceReferences).toEqual([
      'fake-apk-distribution',
    ]);
    expect(validated.confidence).toBe(0.8);
  });

  it('strips a citation that does not correspond to anything in the supplied context and downgrades confidence', () => {
    const result = payload({
      factors: [
        {
          factor: 'Made up claim',
          direction: 'supports_malicious',
          evidenceReferences: ['some-file-that-was-never-supplied.js'],
        },
      ],
    });
    const { result: validated, strippedCount } = validateCitations(
      result,
      context,
    );
    expect(strippedCount).toBe(1);
    expect(validated.factors[0].evidenceReferences).toEqual([]);
    expect(validated.confidence).toBeCloseTo(0.56, 5); // 0.8 * 0.7
  });

  it('handles multiple factors, only downgrading once even if several citations are stripped', () => {
    const result = payload({
      factors: [
        {
          factor: 'A',
          direction: 'supports_malicious',
          evidenceReferences: ['fake-apk-distribution'],
        },
        {
          factor: 'B',
          direction: 'supports_malicious',
          evidenceReferences: ['nonexistent-1', 'nonexistent-2'],
        },
      ],
    });
    const { result: validated, strippedCount } = validateCitations(
      result,
      context,
    );
    expect(strippedCount).toBe(2);
    expect(validated.factors[0].evidenceReferences).toEqual([
      'fake-apk-distribution',
    ]);
    expect(validated.factors[1].evidenceReferences).toEqual([]);
    expect(validated.confidence).toBeCloseTo(0.56, 5);
  });

  it('recognizes deep-review context (README path, flagged file path) as valid citations', () => {
    const result = payload({
      factors: [
        {
          factor: 'Suspicious login form',
          direction: 'supports_malicious',
          evidenceReferences: ['src/login.js'],
        },
      ],
    });
    const { strippedCount } = validateCitations(result, context, {
      flaggedFiles: [{ path: 'src/login.js', text: 'fetch(...)' }],
    });
    expect(strippedCount).toBe(0);
  });
});
