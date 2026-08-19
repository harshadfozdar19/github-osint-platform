import { createHash } from 'crypto';
import { SECRET_PATTERNS } from '../detection/rules/secrets.rule';

export interface DetectedSecretValue {
  patternId: string;
  patternName: string;
  valueHash: string;
}

/**
 * Finds raw secret values in content using the exact same patterns as the
 * live secret-detection rule, but returns only a sha256 hash of each value -
 * never the value itself, and never logs it. Used exclusively during
 * reference ingestion (the client's own code) to build a "known secret"
 * watchlist: if that same hash later turns up during a scan of someone
 * else's repo, it's proof they have the client's actual credential, not
 * just "a secret of the same type" - the difference between a coincidence
 * and a smoking gun.
 */
export function extractSecretValueHashes(
  content: string,
): DetectedSecretValue[] {
  const results: DetectedSecretValue[] = [];
  const seen = new Set<string>();
  for (const pattern of SECRET_PATTERNS) {
    const matches = content.match(pattern.regex);
    if (!matches) continue;
    for (const value of matches) {
      const valueHash = createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
      const dedupeKey = `${pattern.id}:${valueHash}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      results.push({
        patternId: pattern.id,
        patternName: pattern.name,
        valueHash,
      });
    }
  }
  return results;
}
