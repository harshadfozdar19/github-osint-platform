/**
 * Shannon entropy (bits/char) for secret-like token heuristics.
 */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  let entropy = 0;
  const len = value.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER_RE =
  /^(?:changeme|password|secret|example|xxxxx*|your[_-]?|dummy|test|todo|fixme|xxx+|sample|placeholder)/i;

/**
 * True when a string looks like a high-entropy token rather than a placeholder.
 */
export function looksLikeHighEntropySecret(
  value: string,
  options: { minLength?: number; minEntropy?: number } = {},
): boolean {
  const minLength = options.minLength ?? 20;
  const minEntropy = options.minEntropy ?? 3.5;
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (trimmed.length < minLength) return false;
  if (PLACEHOLDER_RE.test(trimmed)) return false;
  if (!/^[A-Za-z0-9_\-/.+=]+$/.test(trimmed)) return false;
  // Mostly digits or repeated char → low value
  if (/^(.)\1+$/.test(trimmed)) return false;
  return shannonEntropy(trimmed) >= minEntropy;
}
