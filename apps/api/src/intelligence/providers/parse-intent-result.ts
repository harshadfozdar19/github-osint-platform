import {
  REPOSITORY_INTENTS,
  RepositoryIntentValue,
} from './intent-provider.interface';

/**
 * Validates and clamps whatever the model actually returned - a forced JSON
 * schema on the request is a strong hint, not a guarantee, especially on
 * smaller/free-tier models that don't reliably honor structured-output
 * constraints. Never trust the raw values into the database unchecked.
 */
export function parseIntentPayload(raw: unknown): {
  intent: RepositoryIntentValue;
  riskScore: number;
  confidence: number;
  reasoning: string;
  signalsUsed: string[];
} {
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

  return { intent, riskScore, confidence, reasoning, signalsUsed };
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
