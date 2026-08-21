import { createHash } from 'crypto';

/**
 * Deterministic JSON stringify (object keys sorted at every level) so two
 * semantically identical context objects always hash the same way
 * regardless of property insertion order - the whole point of the hash is
 * detecting when the context actually changed, not when it was merely
 * rebuilt from the same underlying data.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Identity for "would this call produce the same result as last time" -
 * see IntelligenceService.assess. Two assessments with the same
 * {findingId, contextHash} mean nothing relevant (detections, repo
 * metadata, prompt/taxonomy version) has changed since the last one, so
 * the LLM call can be skipped entirely.
 */
export function computeContextHash(
  context: unknown,
  promptVersion: string,
): string {
  return createHash('sha256')
    .update(stableStringify(context))
    .update(promptVersion)
    .digest('hex');
}
