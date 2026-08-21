import { extractJsonObject, parseIntentPayload } from './parse-intent-result';

describe('parseIntentPayload', () => {
  it('falls back to inconclusive/0/0 for a completely malformed payload', () => {
    const parsed = parseIntentPayload({});
    expect(parsed).toMatchObject({
      intent: 'inconclusive',
      riskScore: 0,
      confidence: 0,
      signalsUsed: [],
      factors: [],
      missingInformation: [],
      needsDeepReview: false,
    });
  });

  it('throws when the response is not an object at all', () => {
    expect(() => parseIntentPayload('not json')).toThrow();
    expect(() => parseIntentPayload(null)).toThrow();
  });

  it('clamps riskScore and confidence into their valid ranges', () => {
    const parsed = parseIntentPayload({
      intent: 'benign',
      riskScore: 500,
      confidence: 5,
      reasoning: 'x',
      signalsUsed: [],
    });
    expect(parsed.riskScore).toBe(100);
    expect(parsed.confidence).toBe(1);
  });

  it('drops a factor entry with an invalid direction instead of trusting it, defaulting to neutral', () => {
    const parsed = parseIntentPayload({
      intent: 'benign',
      riskScore: 10,
      confidence: 0.5,
      reasoning: 'x',
      signalsUsed: [],
      factors: [
        {
          factor: 'weird one',
          direction: 'not-a-real-direction',
          evidenceReferences: ['a'],
        },
      ],
    });
    expect(parsed.factors).toEqual([
      expect.objectContaining({ factor: 'weird one', direction: 'neutral' }),
    ]);
  });

  it('filters out non-string missingInformation entries', () => {
    const parsed = parseIntentPayload({
      intent: 'benign',
      riskScore: 10,
      confidence: 0.5,
      reasoning: 'x',
      signalsUsed: [],
      missingInformation: ['a real gap', 42, null, 'another gap'],
    });
    expect(parsed.missingInformation).toEqual(['a real gap', 'another gap']);
  });

  it('only treats a literal boolean true as needsDeepReview', () => {
    expect(
      parseIntentPayload({
        intent: 'benign',
        riskScore: 10,
        confidence: 0.5,
        reasoning: 'x',
        signalsUsed: [],
        needsDeepReview: 'true',
      }).needsDeepReview,
    ).toBe(false);
    expect(
      parseIntentPayload({
        intent: 'benign',
        riskScore: 10,
        confidence: 0.5,
        reasoning: 'x',
        signalsUsed: [],
        needsDeepReview: true,
      }).needsDeepReview,
    ).toBe(true);
  });

  it('drops a factor entry with a blank factor string entirely', () => {
    const parsed = parseIntentPayload({
      intent: 'benign',
      riskScore: 10,
      confidence: 0.5,
      reasoning: 'x',
      signalsUsed: [],
      factors: [
        { factor: '   ', direction: 'neutral', evidenceReferences: [] },
      ],
    });
    expect(parsed.factors).toEqual([]);
  });
});

describe('extractJsonObject', () => {
  it('parses raw JSON directly', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts JSON from a fenced code block', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts the first {...} block from surrounding prose', () => {
    expect(
      extractJsonObject('Here is the answer: {"a":1} - hope that helps'),
    ).toEqual({
      a: 1,
    });
  });

  it('throws when no JSON object can be located', () => {
    expect(() => extractJsonObject('no json here at all')).toThrow();
  });
});
