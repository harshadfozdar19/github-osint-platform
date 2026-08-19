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
 * Common "insecure default" phrasing anywhere in a value, not just as a
 * prefix - a hardcoded fallback like "${JWT_SECRET:-dev-secret-key-change-
 * in-production}" is a well-known Docker/k8s pattern for "this MUST be
 * overridden in real deployments", not a leaked credential. Deliberately
 * multi-word phrases only (never a bare "test"/"dev"/"sample"), since a
 * single common word could coincidentally appear inside a genuinely real
 * secret value (e.g. a legitimate Stripe test-mode key containing "test").
 */
const PLACEHOLDER_PHRASE_RE =
  /change[-_]?(?:me|this|it)\b|change[-_]?in[-_]?production|not[-_]?(?:a[-_]?)?real[-_]?(?:secret|key|value)?|insecure[-_]?default|replace[-_]?(?:me|this)|to[-_]?be[-_]?changed|do[-_]?not[-_]?use[-_]?in[-_]?prod/i;

// snake_case ("openai_api_key"), SCREAMING_SNAKE_CASE ("API_KEY"), or
// camelCase/PascalCase ("secretAccessKey", "ContinuationToken") - the
// identifier conventions real code actually uses (the first two mainly in
// Python/env-style code, the third constantly in JS/TS property access:
// `config.secretAccessKey`, `resp.continuationToken`). The camelCase
// alternative is deliberately letters-only, digits and underscores are not
// allowed there - that's what still tells a genuine base64/JWT-style secret
// apart from a code reference even when it happens to contain a dot: a real
// secret's segments mix upper/lower/digits with no consistent word-like
// case convention, so a segment containing even one digit never qualifies
// as a camelCase identifier here and falls through to being treated as a
// real value.
const IDENTIFIER_SEGMENT_RE =
  /^(?:[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*|[a-zA-Z]+)$/;

/**
 * True when a value is shaped like a source-code variable/attribute
 * reference (`settings.openai_api_key`, `process.env.API_KEY`,
 * `config.secretAccessKey`, `resp.continuationToken`) rather than a literal
 * secret value - every dot-separated segment follows a real identifier
 * naming convention. Assigning a key name to *another* identifier path is
 * exactly how code reads or passes along a credential defined elsewhere,
 * not how one gets hardcoded; a random token that happens to contain a dot
 * (some base64/JWT-flavored secrets do) won't have this consistent
 * per-segment casing, so it's still caught.
 */
export function looksLikeCodeReference(value: string): boolean {
  const segments = value.trim().split('.');
  if (segments.length < 2) return false;
  return segments.every((s) => IDENTIFIER_SEGMENT_RE.test(s));
}

/**
 * True when a value is an obvious example/placeholder ("your_api_key",
 * "sampleAccessToken", "changeme", a "change this in production" default),
 * independent of length or entropy - unlike looksLikeHighEntropySecret below,
 * this has no minimum-length gate, so it also catches short placeholders that
 * would otherwise fall through a length check entirely. Used by callers that
 * already know a value is shaped like a real secret (matched a specific
 * vendor pattern) and only need to rule out the "this is documentation/example
 * code, not a live credential" case.
 */
export function looksLikePlaceholderValue(value: string): boolean {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  return PLACEHOLDER_RE.test(trimmed) || PLACEHOLDER_PHRASE_RE.test(trimmed);
}

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
  if (PLACEHOLDER_PHRASE_RE.test(trimmed)) return false;
  if (looksLikeCodeReference(trimmed)) return false;
  if (!/^[A-Za-z0-9_\-/.+=]+$/.test(trimmed)) return false;
  // Mostly digits or repeated char → low value
  if (/^(.)\1+$/.test(trimmed)) return false;
  return shannonEntropy(trimmed) >= minEntropy;
}
