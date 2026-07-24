// apps/api/src/common/utils/string-similarity.ts
/**
 * Jaro‑Winkler similarity implementation in pure TypeScript.
 * Returns a value between 0 (no similarity) and 1 (identical strings).
 * This implementation is lightweight, has no external dependencies and works well for
 * short strings such as brand names, aliases, or keywords.
 */
export function jaroWinkler(s1: string, s2: string): number {
  // handle empty strings
  if (!s1.length && !s2.length) return 1;
  if (!s1.length || !s2.length) return 0;

  const maxDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  // 1. Find matching characters
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - maxDist);
    const end = Math.min(i + maxDist + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  // 2. Count transpositions
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;

  // 3. Jaro similarity
  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions) / matches) /
    3;

  // 4. Winkler boost for common prefix (up to 4 chars)
  let prefix = 0;
  const maxPrefix = 4;
  for (let i = 0; i < Math.min(maxPrefix, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  const scalingFactor = 0.1; // standard
  return jaro + prefix * scalingFactor * (1 - jaro);
}
