import { createHash } from 'crypto';

/**
 * Word runs are one token each; every other non-space character (operators,
 * punctuation, braces) is its own token. This makes tokenization blind to
 * whitespace/indentation entirely - a reformatted-but-otherwise-identical
 * file produces the exact same token stream - while still treating code
 * structure (not just identifiers) as signal.
 */
const TOKEN_RE = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;

export function tokenize(content: string): string[] {
  return content.match(TOKEN_RE) ?? [];
}

/**
 * Collapses line-ending and trailing-whitespace differences (common from
 * git checkout / editor churn) before hashing, so two byte-different but
 * semantically-identical checkouts of the same file still exact-match.
 * Deliberately leaves everything else untouched - this is meant to catch
 * verbatim copies, not near-duplicates (that's computeChunkFingerprints).
 */
function normalizeForExactHash(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

export function hashContent(content: string): string {
  return createHash('sha256')
    .update(normalizeForExactHash(content), 'utf8')
    .digest('hex');
}

export interface ChunkFingerprintOptions {
  /** Token window size per shingle. Larger = fewer false-positive overlaps, less sensitive to small edits. */
  kgram?: number;
  /** Winnowing window (in k-grams) - guarantees a match of >= (window + kgram - 1) tokens is never missed. */
  window?: number;
}

const DEFAULT_KGRAM = 25;
const DEFAULT_WINDOW = 4;
/** 64-bit truncation of sha256 - collision risk is negligible at any realistic corpus size and keeps stored arrays small. */
const HASH_TRUNC_LEN = 16;
const TOKEN_SEP = '';

function hashKgram(text: string): string {
  return createHash('sha256')
    .update(text, 'utf8')
    .digest('hex')
    .slice(0, HASH_TRUNC_LEN);
}

/**
 * Winnowing (Schleimer/Wilkerson/Aiken): slides a window over the k-gram
 * hash sequence and keeps the rightmost minimum per window, skipping
 * positions already selected by the previous window. Bounds the number of
 * stored fingerprints per file to roughly 2/(window+1) of the raw k-gram
 * count regardless of file size, while guaranteeing any shared substring of
 * at least (window + kgram - 1) tokens between two files produces at least
 * one shared fingerprint.
 */
export function computeChunkFingerprints(
  content: string,
  options: ChunkFingerprintOptions = {},
): string[] {
  const kgram = options.kgram ?? DEFAULT_KGRAM;
  const window = options.window ?? DEFAULT_WINDOW;
  if (kgram < 1) throw new Error('kgram must be >= 1');
  if (window < 1) throw new Error('window must be >= 1');

  const tokens = tokenize(content);
  if (tokens.length === 0) return [];

  // Too short for even one full k-gram: fingerprint the whole token stream
  // as a single chunk so tiny files remain matchable rather than invisible.
  if (tokens.length < kgram) {
    return [hashKgram(tokens.join(TOKEN_SEP))];
  }

  const hashes: string[] = [];
  for (let i = 0; i <= tokens.length - kgram; i++) {
    hashes.push(hashKgram(tokens.slice(i, i + kgram).join(TOKEN_SEP)));
  }

  // Not enough k-grams to form a full winnowing window - nothing to bound,
  // so keep every distinct k-gram hash instead of collapsing to one.
  if (hashes.length <= window) {
    return [...new Set(hashes)];
  }

  const fingerprints: string[] = [];
  let lastSelectedIndex = -1;
  for (let start = 0; start <= hashes.length - window; start++) {
    let minIndex = start;
    let minVal = hashes[start];
    // Rightmost minimum on ties: prevents re-selecting the same position
    // from the immediately preceding window on runs of equal hashes.
    for (let i = start + 1; i < start + window; i++) {
      if (hashes[i] <= minVal) {
        minVal = hashes[i];
        minIndex = i;
      }
    }
    if (minIndex !== lastSelectedIndex) {
      fingerprints.push(minVal);
      lastSelectedIndex = minIndex;
    }
  }
  return [...new Set(fingerprints)];
}
