import {
  FACTOR_DIRECTIONS,
  IntentFactor,
  REPOSITORY_INTENTS,
  RepositoryIntentValue,
} from './intent-provider.interface';

export interface ParsedIntentPayload {
  intent: RepositoryIntentValue;
  riskScore: number;
  confidence: number;
  reasoning: string;
  signalsUsed: string[];
  factors: IntentFactor[];
  missingInformation: string[];
  needsDeepReview: boolean;
}

/**
 * Validates and clamps whatever the model actually returned - a forced JSON
 * schema on the request is a strong hint, not a guarantee, especially on
 * smaller/free-tier models that don't reliably honor structured-output
 * constraints. Never trust the raw values into the database unchecked.
 */
export function parseIntentPayload(raw: unknown): ParsedIntentPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Model response was not a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const intent = REPOSITORY_INTENTS.includes(
    obj.intent as RepositoryIntentValue,
  )
    ? (obj.intent as RepositoryIntentValue)
    : 'inconclusive';

  const riskScore = clamp(Number(obj.riskScore), 0, 100, 0);
  const confidence = clamp(Number(obj.confidence), 0, 1, 0);

  const reasoning =
    typeof obj.reasoning === 'string' && obj.reasoning.trim()
      ? obj.reasoning.trim().slice(0, 2000)
      : 'No reasoning provided by model.';

  const signalsUsed = Array.isArray(obj.signalsUsed)
    ? obj.signalsUsed
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 20)
    : [];

  const factors: IntentFactor[] = Array.isArray(obj.factors)
    ? obj.factors
        .filter(
          (f): f is Record<string, unknown> => !!f && typeof f === 'object',
        )
        .map((f) => ({
          factor:
            typeof f.factor === 'string' ? f.factor.trim().slice(0, 300) : '',
          direction: FACTOR_DIRECTIONS.includes(
            f.direction as (typeof FACTOR_DIRECTIONS)[number],
          )
            ? (f.direction as IntentFactor['direction'])
            : 'neutral',
          evidenceReferences: Array.isArray(f.evidenceReferences)
            ? f.evidenceReferences
                .filter((r): r is string => typeof r === 'string')
                .slice(0, 10)
            : [],
        }))
        .filter((f) => f.factor.length > 0)
        .slice(0, 10)
    : [];

  const missingInformation = Array.isArray(obj.missingInformation)
    ? obj.missingInformation
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().slice(0, 300))
        .filter((s) => s.length > 0)
        .slice(0, 10)
    : [];

  const needsDeepReview = obj.needsDeepReview === true;

  return {
    intent,
    riskScore,
    confidence,
    reasoning,
    signalsUsed,
    factors,
    missingInformation,
    needsDeepReview,
  };
}

function clamp(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Free/open-source models routed through OpenRouter often ignore
 * response_format and wrap JSON in prose or a ```json fence - this pulls
 * the first {...} block out rather than failing outright.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence/brace extraction
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error('Could not locate a JSON object in the model response');
}
