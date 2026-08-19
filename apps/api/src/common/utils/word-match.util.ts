const ALNUM_RE = /[a-zA-Z0-9]/;
const UPPER_RE = /[A-Z]/;
const LOWER_ALNUM_RE = /[a-z0-9]/;

/**
 * Whether the occurrence of `needle` at `index` in `original` (a haystack
 * with its original casing preserved) is a genuine word/identifier
 * COMPONENT, not a run of letters buried mid-word inside an unrelated
 * longer word - "fyers" inside "identifyers"/"modifyers" must be rejected,
 * while "fyers" inside "fyersModel"/"FyersModel"/"fyers_callback"/
 * "/fyers/callback" must still count, since those are exactly how a real
 * mention of a brand/keyword shows up compounded into an identifier or
 * path. A boundary on either side is satisfied by: start/end of string, any
 * non-alphanumeric separator (., _, -, /, whitespace, punctuation, ...), or
 * a camelCase/PascalCase case transition (a lowercase char immediately
 * before an uppercase match-start, or an uppercase char immediately after
 * the match) - the same compounding GitHub's own code search treats as
 * separate tokens.
 */
function isWordBoundaryHit(
  original: string,
  index: number,
  length: number,
): boolean {
  const before = index > 0 ? original[index - 1] : '';
  const matchStart = original[index] || '';
  const after = original[index + length] || '';
  const beforeOk =
    !before ||
    !ALNUM_RE.test(before) ||
    (UPPER_RE.test(matchStart) && LOWER_ALNUM_RE.test(before));
  const afterOk = !after || !ALNUM_RE.test(after) || UPPER_RE.test(after);
  return beforeOk && afterOk;
}

/**
 * Index of the first word-boundary-safe occurrence of `needleLower`
 * (already lowercased) in `haystack`, or -1 if every occurrence is buried
 * mid-word - see isWordBoundaryHit. Case-insensitive: matches against
 * `haystack.toLowerCase()` but boundary checks (the camelCase transition
 * rule) look at `haystack`'s own original casing.
 */
export function findWordBoundaryIndex(
  haystack: string,
  needleLower: string,
): number {
  if (!needleLower) return -1;
  const lowerHaystack = haystack.toLowerCase();
  let fromIndex = 0;
  for (;;) {
    const idx = lowerHaystack.indexOf(needleLower, fromIndex);
    if (idx === -1) return -1;
    if (isWordBoundaryHit(haystack, idx, needleLower.length)) return idx;
    fromIndex = idx + 1;
  }
}

/** Whether `needleLower` (already lowercased) appears anywhere in `haystack` as a genuine word/identifier component - see findWordBoundaryIndex. */
export function hasWordBoundaryMatch(
  haystack: string,
  needleLower: string,
): boolean {
  return findWordBoundaryIndex(haystack, needleLower) !== -1;
}

/** First alias (in list order, already lowercased) with a word-boundary match in `text`, and where it was found - or null if none match. */
export function findAliasWordMatch(
  text: string,
  aliasesLower: string[],
): { alias: string; index: number } | null {
  for (const alias of aliasesLower) {
    const idx = findWordBoundaryIndex(text, alias);
    if (idx !== -1) return { alias, index: idx };
  }
  return null;
}
