/**
 * Extracts candidate "bait" phrases from a brand's own content (UI strings,
 * locale files, templates, legal/README text) - text distinctive enough that
 * an exact match elsewhere is unlikely to be coincidence, unlike generic
 * code patterns. Deliberately format-agnostic (works on JSON, plain text,
 * HTML) rather than parsing each content format properly, since the goal is
 * "good enough bait for a GitHub search query", not a content model.
 */

const MIN_PHRASE_LEN = 12;
const MAX_PHRASE_LEN = 200;
const MIN_SIGNIFICANT_WORDS = 3;
const MIN_SIGNIFICANT_WORD_LEN = 4;

/** Common English function words - excluded so "with your account for the" doesn't count as 5 significant words. */
const STOPWORDS = new Set([
  'that',
  'this',
  'with',
  'from',
  'your',
  'have',
  'will',
  'would',
  'could',
  'should',
  'their',
  'there',
  'these',
  'those',
  'about',
  'into',
  'when',
  'where',
  'which',
  'while',
  'what',
  'were',
  'been',
  'being',
  'does',
  'each',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'than',
  'then',
  'them',
  'they',
  'here',
  'over',
  'under',
  'again',
  'once',
  'both',
  'because',
  'before',
  'after',
  'above',
  'below',
  'between',
  'through',
  'during',
  'please',
  'thank',
  'thanks',
  'welcome',
  'click',
  'continue',
]);

/** Ubiquitous boilerplate that shows up verbatim across countless unrelated products - never useful as evidence on its own. */
const COMMON_PHRASE_BLOCKLIST = new Set(
  [
    'all rights reserved',
    'terms and conditions',
    'terms of service',
    'privacy policy',
    'please try again later',
    'invalid email or password',
    'sign in to continue',
    'forgot your password',
    'something went wrong',
    'page not found',
    'loading please wait',
    'you have been logged out',
  ].map((p) => p.toLowerCase()),
);

export interface DistinctivePhrase {
  text: string;
  significantWordCount: number;
}

const QUOTED_SEGMENT_RE = /"(?:[^"\\]|\\.){3,300}"|'(?:[^'\\]|\\.){3,300}'/g;

/**
 * Per line: if it contains quoted string literals (JSON/JS/config-style),
 * extract only those quoted values - not also the raw line, which for a
 * `"key": "value"` line would otherwise produce both a clean phrase AND a
 * noisy duplicate containing braces/keys/punctuation. Falls back to the
 * whole trimmed line only when no quotes are present, which is what covers
 * unquoted prose (README/legal text).
 */
function candidateSegments(content: string): string[] {
  const segments: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const quoted = line.match(QUOTED_SEGMENT_RE);
    if (quoted && quoted.length > 0) {
      for (const q of quoted) segments.push(q.slice(1, -1));
    } else {
      segments.push(line);
    }
  }
  return segments;
}

function countSignificantWords(text: string): number {
  const words = text.toLowerCase().match(/[a-z]{2,}/g) || [];
  let count = 0;
  for (const w of words) {
    if (w.length >= MIN_SIGNIFICANT_WORD_LEN && !STOPWORDS.has(w)) count += 1;
  }
  return count;
}

/**
 * Returns distinctive phrases found in `content`, most-distinctive first,
 * deduplicated case-insensitively. A phrase must be long enough to be a
 * meaningful GitHub search query, contain enough non-generic words to be
 * unlikely elsewhere by coincidence, and not be known ubiquitous boilerplate.
 */
export function extractDistinctivePhrases(
  content: string,
): DistinctivePhrase[] {
  const seen = new Set<string>();
  const results: DistinctivePhrase[] = [];

  for (const raw of candidateSegments(content)) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length < MIN_PHRASE_LEN || text.length > MAX_PHRASE_LEN) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    if (COMMON_PHRASE_BLOCKLIST.has(key)) continue;

    const significantWordCount = countSignificantWords(text);
    if (significantWordCount < MIN_SIGNIFICANT_WORDS) continue;

    seen.add(key);
    results.push({ text, significantWordCount });
  }

  return results.sort(
    (a, b) => b.significantWordCount - a.significantWordCount,
  );
}
