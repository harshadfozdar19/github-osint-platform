import { BadRequestException } from '@nestjs/common';
import { generateTypoVariants } from './typo-squat';
import { dedupeKeywordsCaseInsensitive } from '../../common/utils/dedupe-keywords';

export type SearchKind = 'repositories' | 'code';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** GitHub's own founding — a floor below which "created:" is never meaningful. */
const EARLIEST_SANE_DATE = '2008-01-01';

/**
 * Wraps a multi-word term in quotes so GitHub treats it as one exact
 * phrase instead of independent words that can match anywhere, in any
 * order, unrelated to each other - the same reasoning already applied to
 * safeKeyword everywhere below, just also applied to the brand's own
 * identity term (`safe`/`term`), which is just as often multi-word ("Angel
 * One", "Paytm Mall", ...) and was previously left bare in every
 * repository-search query, silently splitting it into independent
 * single-word terms while the matching code-search query for the exact
 * same brand correctly quoted it. No-op for a single-word term, which
 * already behaves as a phrase with or without quotes.
 */
function phraseify(term: string): string {
  return term.includes(' ') ? `"${term}"` : term;
}

/** Normalizes to GitHub's YYYY-MM-DD qualifier format; throws on anything else. */
function normalizeDate(input: string, field: string): string {
  const trimmed = input.trim();
  if (DATE_RE.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid date (YYYY-MM-DD)`);
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * Shared validation for a GitHub date-range qualifier (`created:` or
 * `pushed:`) from a from/to pair. Only meaningful for repository search —
 * GitHub's code search API supports neither qualifier at all, so callers
 * scoping a raw code-search query must reject a date range before reaching
 * here rather than silently dropping it.
 */
function buildDateRangeQualifier(
  qualifier: string,
  from: string | undefined,
  to: string | undefined,
  fromLabel: string,
  toLabel: string,
): string | undefined {
  if (!from && !to) return undefined;
  const normalizedFrom = from ? normalizeDate(from, fromLabel) : undefined;
  const normalizedTo = to ? normalizeDate(to, toLabel) : undefined;

  for (const [label, value] of [
    [fromLabel, normalizedFrom],
    [toLabel, normalizedTo],
  ] as const) {
    if (value && value < EARLIEST_SANE_DATE) {
      throw new BadRequestException(`${label} predates GitHub itself`);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (value && value > today) {
      throw new BadRequestException(`${label} cannot be in the future`);
    }
  }
  if (normalizedFrom && normalizedTo && normalizedFrom > normalizedTo) {
    throw new BadRequestException(`${fromLabel} must not be after ${toLabel}`);
  }

  if (normalizedFrom && normalizedTo)
    return `${qualifier}:${normalizedFrom}..${normalizedTo}`;
  if (normalizedFrom) return `${qualifier}:>=${normalizedFrom}`;
  return `${qualifier}:<=${normalizedTo}`;
}

/**
 * Validates and builds a GitHub `created:` search qualifier from a from/to
 * range - filters by when the REPOSITORY ITSELF was created. See
 * buildPushedQualifier for "was there recent activity" instead, which is a
 * different (and for "show me new/changed repos" purposes, usually more
 * useful) question - a repo created years ago that just had a secret or a
 * brand mention added today has an old, unchanging creation date but a
 * brand-new push date.
 */
export function buildCreatedQualifier(
  createdFrom?: string,
  createdTo?: string,
): string | undefined {
  return buildDateRangeQualifier(
    'created',
    createdFrom,
    createdTo,
    'createdFrom',
    'createdTo',
  );
}

/**
 * Validates and builds a GitHub `pushed:` search qualifier from a from/to
 * range - filters by when the repository was last pushed to (commits,
 * branch updates), independent of when it was originally created. This is
 * what actually answers "show me repos with recent activity," as opposed to
 * buildCreatedQualifier's "show me repos that are themselves new." The two
 * can be combined freely (GitHub ANDs multiple qualifiers together in one
 * query) - e.g. createdFrom+createdTo for "brand-new repos" alongside
 * pushedFrom+pushedTo for "and they've been touched recently," or either
 * one alone.
 */
export function buildPushedQualifier(
  pushedFrom?: string,
  pushedTo?: string,
): string | undefined {
  return buildDateRangeQualifier(
    'pushed',
    pushedFrom,
    pushedTo,
    'pushedFrom',
    'pushedTo',
  );
}

/**
 * Combines a created: and a pushed: qualifier into either one AND'd string
 * or two independent OR alternatives, depending on mode - see
 * dateFilterMode on buildQueryFamilies for the full reasoning. Returns an
 * empty array when neither qualifier applies, a one-element array when only
 * one does (or mode is 'and'/default), or a two-element array only when
 * mode is 'or' AND both qualifiers are present - the two elements are then
 * meant to become two SEPARATE queries, not one combined string, since
 * GitHub's search syntax has no OR between two different qualifier types.
 * Exported separately from buildQueryFamilies so a caller building one raw
 * query directly (a customQuery-scoped scan) can get the same OR-splitting
 * behavior without going through the full family-generation pipeline.
 */
export function buildDateQualifierVariants(
  createdFrom: string | undefined,
  createdTo: string | undefined,
  pushedFrom: string | undefined,
  pushedTo: string | undefined,
  mode: 'and' | 'or' = 'and',
): string[] {
  const createdQualifier = buildCreatedQualifier(createdFrom, createdTo);
  const pushedQualifier = buildPushedQualifier(pushedFrom, pushedTo);
  if (mode === 'or' && createdQualifier && pushedQualifier) {
    return [createdQualifier, pushedQualifier];
  }
  const combined = [createdQualifier, pushedQualifier]
    .filter(Boolean)
    .join(' ');
  return combined ? [combined] : [];
}

function endOfUtcDay(d: Date): number {
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    23,
    59,
    59,
    999,
  );
}

/**
 * In-process equivalent of buildCreatedQualifier/buildPushedQualifier for
 * internal audits - those enumerate a brand's own trustedGithubOwners repos
 * directly via REST (listAllOwnerRepos), never through GitHub Search, so
 * there's no query string to attach a `created:`/`pushed:` qualifier to.
 * This filters the resulting repo list the same way, in memory, against
 * each item's own created_at/pushed_at. `to` bounds are treated as
 * inclusive of the whole UTC day, matching GitHub's own `created:YYYY-MM-DD`
 * semantics - without that, a repo created at 14:00 today would fail a
 * createdTo of today's midnight-exact Date.
 */
export function repoMatchesActivityWindow(
  // Optional - a code-search result's embedded repo object never includes
  // these (see GitHubRepoSearchItem.created_at); an unknown date can't be
  // confirmed to fall inside a requested window, so it's treated as not
  // matching that axis below rather than assumed to pass.
  item: { created_at?: string; pushed_at?: string },
  window: {
    createdFrom?: Date;
    createdTo?: Date;
    pushedFrom?: Date;
    pushedTo?: Date;
    dateFilterMode?: 'and' | 'or';
  },
): boolean {
  const hasCreatedBound = Boolean(window.createdFrom || window.createdTo);
  const hasPushedBound = Boolean(window.pushedFrom || window.pushedTo);
  if (!hasCreatedBound && !hasPushedBound) return true;

  const createdAt = item.created_at
    ? new Date(item.created_at).getTime()
    : undefined;
  const pushedAt = item.pushed_at
    ? new Date(item.pushed_at).getTime()
    : undefined;

  const createdMatches =
    !hasCreatedBound ||
    (createdAt !== undefined &&
      (!window.createdFrom || createdAt >= window.createdFrom.getTime()) &&
      (!window.createdTo || createdAt <= endOfUtcDay(window.createdTo)));
  const pushedMatches =
    !hasPushedBound ||
    (pushedAt !== undefined &&
      (!window.pushedFrom || pushedAt >= window.pushedFrom.getTime()) &&
      (!window.pushedTo || pushedAt <= endOfUtcDay(window.pushedTo)));

  if (hasCreatedBound && hasPushedBound) {
    return window.dateFilterMode === 'or'
      ? createdMatches || pushedMatches
      : createdMatches && pushedMatches;
  }
  return hasCreatedBound ? createdMatches : pushedMatches;
}

/**
 * Adaptive overflow relief for GitHub CODE search, which has no `created:`
 * qualifier to date-slice by (see buildCreatedQualifier above) - the only
 * queries actually at risk of losing results past GitHub's 1000-per-query
 * cap are the brand-agnostic global sweeps (secret-filename family: no
 * brand term narrows them, so they search all of GitHub for a generic
 * pattern). `language:` is the one qualifier that applies uniformly to any
 * of those queries regardless of shape (unlike extension:/filename:, which
 * are often already baked into the base query and can't be added twice).
 * Deliberately a single, fixed, modest dimension - not a cross-product of
 * extension x filename x language - so triggering this for every
 * over-threshold query still only adds a small, bounded number of extra
 * requests, not a combinatorial explosion of mostly-empty ones.
 */
export const CODE_SEARCH_SPLIT_LANGUAGES: readonly string[] = [
  'JavaScript',
  'TypeScript',
  'Python',
  'Java',
  'Go',
  'PHP',
  'Ruby',
  'Shell',
];

/**
 * Each returned query is a genuinely different string, so the existing
 * DiscoveryCursor mechanism (keyed by exact query text) automatically gives
 * every one its own independent 1000-result budget and resume cursor - no
 * new plumbing needed for that part, same as date-slicing gets for free.
 *
 * Returns CODE_SEARCH_SPLIT_LANGUAGES.length + 1 queries, not just
 * CODE_SEARCH_SPLIT_LANGUAGES.length: GitHub's language detection doesn't
 * classify every file - config/dotfiles like `.env` often land in no
 * language at all, or "Other" - so the 8 `language:X` buckets alone would
 * permanently miss exactly the kind of file this codebase's own
 * secret-filename queries are built to find. The final query negates every
 * one of the 8 (`-language:JavaScript -language:TypeScript ...`), which
 * GitHub's search syntax supports as a genuine "everything not already
 * covered above" catch-all - together with the 8 positive buckets, every
 * file GitHub returns for the base query is now covered by exactly one of
 * the 9, not just "most of them."
 */
export function buildLanguageSplitQueries(baseQuery: string): string[] {
  const perLanguage = CODE_SEARCH_SPLIT_LANGUAGES.map(
    (lang) => `${baseQuery} language:${lang}`,
  );
  const unclassifiedOrOther = `${baseQuery} ${CODE_SEARCH_SPLIT_LANGUAGES.map(
    (lang) => `-language:${lang}`,
  ).join(' ')}`;
  return [...perLanguage, unclassifiedOrOther];
}

const CREATED_RANGE_RE = /created:(\S+)\.\.(\S+)/;

/**
 * Formats a Date the way GitHub's `created:` qualifier expects - full ISO
 * 8601, with the milliseconds component dropped (GitHub doesn't need
 * sub-second precision, and a plain `...00Z` reads cleaner in a query
 * string / a saved DiscoveryCursor than `...000Z`).
 */
function toGithubTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Below this width, splitting further can't meaningfully help - GitHub's
// own search index doesn't refresh finer than roughly this anyway, and
// going narrower risks spending requests without making real progress.
const MIN_SPLIT_WIDTH_MS = 60_000;

/**
 * GitHub treats a bare `YYYY-MM-DD` boundary as covering that whole day
 * (e.g. `created:2026-08-07..2026-08-07` - exactly what "Only today's
 * repos" produces - means all of Aug 7, not one instant). A naive
 * `new Date(str)` parses a bare date to UTC midnight, so a same-day range
 * would otherwise measure as zero width and never be recognized as
 * splittable even when it's actually a full ~24-hour window. Only the END
 * of a range needs this adjustment - a bare date as the START boundary
 * already correctly means "from the start of that day," which
 * `new Date()` gets right on its own.
 */
function parseRangeEnd(str: string): Date {
  const date = new Date(str);
  if (DATE_RE.test(str)) {
    return new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  return date;
}

/**
 * Recursively-splittable overflow relief for REPOSITORY search - unlike
 * code search, `created:` IS supported here (see buildCreatedQualifier),
 * so a query that's still over the 1000-result cap even after being
 * windowed to one day (e.g. a viral brand-impersonation moment) can be
 * bisected indefinitely finely - hours, minutes - until every slice is
 * safely under the cap. Deliberately allowed to recurse, unlike the
 * one-level code-search language split: each half becomes its own
 * independent query with its own DiscoveryCursor, checked the same way
 * when its own turn comes, and split again if it's STILL too big - the
 * queue naturally provides the recursion, no explicit loop needed here.
 * Returns null when there's no bounded `created:X..Y` range to split (an
 * unbounded `>=`/`<=` filter, or no date filter applied at all - see
 * ensureBoundedCreatedRange below, which normalizes both of those into a
 * bounded range so callers don't need to fall back to the plain
 * exhausted/reset-to-page-1 behavior just because the scan itself never
 * set a date filter) or when the range is already too narrow to usefully
 * split further.
 */
export function splitCreatedRangeQuery(query: string): [string, string] | null {
  const match = query.match(CREATED_RANGE_RE);
  if (!match) return null;
  const [full, fromStr, toStr] = match;
  const from = new Date(fromStr);
  const to = parseRangeEnd(toStr);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  const widthMs = to.getTime() - from.getTime();
  if (widthMs < MIN_SPLIT_WIDTH_MS) return null;

  const midMs = from.getTime() + Math.floor(widthMs / 2);
  const firstHalfEnd = toGithubTimestamp(new Date(midMs - 1000));
  const secondHalfStart = toGithubTimestamp(new Date(midMs));

  const firstHalf = query.replace(full, `created:${fromStr}..${firstHalfEnd}`);
  const secondHalf = query.replace(
    full,
    `created:${secondHalfStart}..${toStr}`,
  );
  return [firstHalf, secondHalf];
}

const UNBOUNDED_FROM_RE = /created:>=(\S+)/;
const UNBOUNDED_TO_RE = /created:<=(\S+)/;

/**
 * Fixed, far-future stand-in for "today" as the synthesized upper bound in
 * ensureBoundedCreatedRange - deliberately NOT `new Date()`. A repo can
 * never have a future created_at, so this ceiling matches exactly the same
 * real repos "today" would, but as a CONSTANT rather than something that
 * advances every calendar day.
 *
 * This matters because DiscoveryCursor resumption (discovery-cursor.service
 * .getResumePage) is keyed on the exact query TEXT, and splitCreatedRangeQuery
 * bisects a range at its literal midpoint. When the upper bound was `today`,
 * that midpoint drifted by ~12 hours every single day (half of one day's
 * added width across an ~18-year span) - so a query that had already been
 * split and paginated partway through (a real, in-progress DiscoveryCursor
 * at page 5, page 9, ...) produced a DIFFERENT query string the next time
 * the same brand-agnostic top-level query restarted (which happens on every
 * scan turn once the parent query is marked exhausted). The new string
 * never matched the old cursor's hash, so that in-progress cursor was
 * silently orphaned and pagination restarted near page 1 on an
 * almost-but-not-quite-identical sibling range - forever re-walking the
 * shallow, already-known top of the range and never reaching the deeper,
 * not-yet-seen pages where genuinely new repos were waiting. Pinning this
 * to a fixed constant makes the produced query text (and therefore cursor
 * resumption) stable indefinitely, regardless of what day it is.
 */
const FAR_FUTURE_DATE = '2099-12-31';

/**
 * Normalizes ANY repository-search query into having a bounded
 * `created:X..Y` range - the one shape splitCreatedRangeQuery can actually
 * bisect - so overflow relief isn't limited to scans that happened to opt
 * into a two-sided date filter. Without this, a query that overflows 1000
 * results purely because it was never date-scoped at all would just
 * silently cap at the top 1000 most-recently-updated results forever,
 * identical on every future scan.
 *  - Already bounded (`created:X..Y`): returned unchanged.
 *  - Only a lower bound (`created:>=X`, from buildCreatedQualifier when just
 *    createdFrom was set): bounded up to FAR_FUTURE_DATE (effectively "no
 *    upper limit", but as a stable constant - see FAR_FUTURE_DATE).
 *  - Only an upper bound (`created:<=Y`): bounded down to
 *    EARLIEST_SANE_DATE - GitHub's own founding, so this is a real ceiling
 *    on how far back real results can exist, not an arbitrary guess.
 *  - No `created:` qualifier at all: the full EARLIEST_SANE_DATE..
 *    FAR_FUTURE_DATE range is appended.
 */
export function ensureBoundedCreatedRange(query: string): string {
  if (CREATED_RANGE_RE.test(query)) return query;

  const fromMatch = query.match(UNBOUNDED_FROM_RE);
  if (fromMatch) {
    return query.replace(
      UNBOUNDED_FROM_RE,
      `created:${fromMatch[1]}..${FAR_FUTURE_DATE}`,
    );
  }

  const toMatch = query.match(UNBOUNDED_TO_RE);
  if (toMatch) {
    return query.replace(
      UNBOUNDED_TO_RE,
      `created:${EARLIEST_SANE_DATE}..${toMatch[1]}`,
    );
  }

  return `${query} created:${EARLIEST_SANE_DATE}..${FAR_FUTURE_DATE}`;
}

const SIZE_RANGE_RE = /size:(\d+)\.\.(\d+)/;
/**
 * Generous upper bound in bytes for GitHub code search's `size:` qualifier
 * (which operates in bytes, unlike repository search's `size:` which is
 * KB) - not GitHub's true internal indexing limit (undocumented, and not
 * this codebase's business to guess precisely), just a ceiling high enough
 * that no realistically indexed source/config file exceeds it, the same
 * role EARLIEST_SANE_DATE plays for dates above.
 */
const MAX_CODE_FILE_SIZE_BYTES = 100_000_000;
// Below this width, bisecting further can't meaningfully narrow anything -
// each half would still span enough distinct byte values to plausibly
// contain hundreds of files - same role MIN_SPLIT_WIDTH_MS plays for dates.
const MIN_SPLIT_SIZE_WIDTH_BYTES = 16;

/**
 * Second overflow-relief dimension for CODE search, layered on top of (not
 * instead of) buildLanguageSplitQueries - GitHub code search has no
 * `created:` qualifier (see splitCreatedRangeQuery's docstring), but it
 * does support `size:` with the same bounded-range/bisection shape as
 * repository search's `created:` - so a query that's STILL over the 1000
 * cap after being split 8 ways by language (e.g. a brand-agnostic
 * secret-filename sweep with a genuinely huge total_count) can be bisected
 * further by file size, recursively, the same way splitCreatedRangeQuery
 * recurses: each half becomes its own independent query, re-checked and
 * split again if it's still too big, until every leaf is safely under the
 * cap or the recursion depth cap is reached. Returns null once the range is
 * already too narrow to usefully split further.
 */
export function splitSizeRangeQuery(query: string): [string, string] | null {
  const match = query.match(SIZE_RANGE_RE);
  if (!match) return null;
  const [full, minStr, maxStr] = match;
  const min = Number(minStr);
  const max = Number(maxStr);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }
  const width = max - min;
  if (width < MIN_SPLIT_SIZE_WIDTH_BYTES) return null;

  const mid = min + Math.floor(width / 2);
  const firstHalf = query.replace(full, `size:${min}..${mid}`);
  const secondHalf = query.replace(full, `size:${mid + 1}..${max}`);
  return [firstHalf, secondHalf];
}

const UNBOUNDED_SIZE_GT_RE = /size:>=?(\d+)/;
const UNBOUNDED_SIZE_LT_RE = /size:<=?(\d+)/;

/**
 * Normalizes ANY code-search query into having a bounded `size:X..Y` range
 * - mirrors ensureBoundedCreatedRange exactly, one level down (bytes
 * instead of dates). Nothing in this codebase's own query templates
 * currently sets a `size:` qualifier (see buildQueryFamilies), so in
 * practice every call hits the "no qualifier at all" branch today - the
 * bounded/unbounded branches exist so a future rule template that DOES
 * add its own size: filter still gets correct overflow relief instead of
 * a silently-broken double qualifier.
 */
export function ensureBoundedSizeRange(query: string): string {
  if (SIZE_RANGE_RE.test(query)) return query;

  const gtMatch = query.match(UNBOUNDED_SIZE_GT_RE);
  if (gtMatch) {
    return query.replace(
      UNBOUNDED_SIZE_GT_RE,
      `size:${gtMatch[1]}..${MAX_CODE_FILE_SIZE_BYTES}`,
    );
  }

  const ltMatch = query.match(UNBOUNDED_SIZE_LT_RE);
  if (ltMatch) {
    return query.replace(UNBOUNDED_SIZE_LT_RE, `size:0..${ltMatch[1]}`);
  }

  return `${query} size:0..${MAX_CODE_FILE_SIZE_BYTES}`;
}

export interface SearchQuerySpec {
  query: string;
  kind: SearchKind;
  family: string;
}

export interface BrandQueryInput {
  name: string;
  aliases: string[];
  keywords: string[];
  /** This brand's own real GitHub org/user accounts, if known. */
  trustedGithubOwners?: string[];
  /**
   * Distinctive brand-content phrases (UI copy, locale strings, legal text -
   * see fingerprints/distinctive-content.util.ts), used as high-precision
   * GitHub code-search bait. An exact match on a rare, multi-word phrase
   * pulled from the brand's own content is far less likely to be a
   * coincidence than a generic keyword match.
   */
  distinctivePhrases?: string[];
}

export interface DistinctivePhraseRow {
  brandId: unknown;
  text: string;
}

/**
 * Buckets phrase rows by brand, keeping only the top `limit` per brand.
 * Assumes rows are already sorted most-distinctive-first (e.g. by
 * significantWordCount descending) and simply takes the first `limit` rows
 * encountered per brand in that order - equivalent to each brand's own
 * top-`limit` subset regardless of how rows from different brands are
 * interleaved in the input.
 */
export function groupTopPhrasesByBrand(
  rows: DistinctivePhraseRow[],
  limit: number,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const key = String(row.brandId);
    let list = result.get(key);
    if (!list) {
      list = [];
      result.set(key, list);
    }
    if (list.length < limit) list.push(row.text);
  }
  return result;
}

export interface KeywordQueryInput {
  keyword: string;
  category: string;
  priority: number;
  enabled?: boolean;
}

/** Pick top keywords for a category, sorted by priority (desc) then keyword (asc). */
function topKeywordsByCategory(
  keywords: KeywordQueryInput[],
  category: string,
  limit = 5,
): string[] {
  return keywords
    .filter((k) => k.enabled !== false && k.category === category)
    .sort(
      (a, b) => b.priority - a.priority || a.keyword.localeCompare(b.keyword),
    )
    .slice(0, limit)
    .map((k) => k.keyword);
}

/**
 * Build diversified discovery queries using dynamic companies and keywords
 * with support for language, date, and stars filters.
 */
export function buildQueryFamilies(
  brands: BrandQueryInput[],
  options: {
    maxQueries?: number;
    enableCodeSearch?: boolean;
    includeSecretFilenames?: boolean;
    keywords?: KeywordQueryInput[];
    /** Per-scan repo creation date range; takes priority over GITHUB_SEARCH_DATE when set. */
    createdFrom?: string;
    createdTo?: string;
    /** Per-scan repo last-push (activity) date range - see buildPushedQualifier. Independent of createdFrom/createdTo; both can be set together. */
    pushedFrom?: string;
    pushedTo?: string;
    /**
     * True when the caller scoped this scan to specific brand(s) rather than
     * sweeping the whole workspace (scan.scopeBrandId set). Suppresses every
     * family below that is inherently brand-agnostic by design - the
     * secret-filename credential sweep (searches ALL of GitHub for `.env`
     * files with AKIA keys, credentials.json, PEM private keys, ... with
     * zero relation to any brand) and the brand-agnostic keyword sweep
     * (uses the workspace's own global "brand"-category Keywords list,
     * which can - and normally does - include OTHER monitored brands, not
     * the one this scan was scoped to). Without this, a scan explicitly
     * scoped to one brand would still silently pull in unrelated repos from
     * these two families, each producing a Finding with no brand
     * attribution at all since secretDetectionRule/phishingRule/
     * malwareRule fire on pure content patterns with no brand match
     * required - exactly the "results not related to the brand I searched"
     * symptom this option exists to prevent.
     */
    scopedToBrand?: boolean;
    /**
     * 'and' (default): a repository must satisfy BOTH createdFrom/createdTo
     * AND pushedFrom/pushedTo when both are set - the literal, narrower
     * intersection. 'or': satisfy EITHER one - e.g. "created today OR
     * pushed today," which is what most people actually mean by "show me
     * what's new or changed today." GitHub's search syntax has no OR
     * between two different qualifiers in one query string, so 'or' mode
     * is implemented by issuing every repository-search query TWICE (once
     * per qualifier) instead of once - each is a genuinely distinct query
     * string, so it gets its own DiscoveryCursor/budget, and per-scan repo
     * dedup (claimRepositoryForAnalysis) already prevents a repo matching
     * both variants from being analyzed twice. Only takes effect when BOTH
     * a created qualifier AND a pushed qualifier are actually present -
     * with only one of them set, 'and'/'or' produce the same single query.
     */
    dateFilterMode?: 'and' | 'or';
    /**
     * Restricts every brand passed in to ONLY its brand-keyword-custom /
     * brand-keyword-custom-code query pair for this exact keyword -
     * phishing/apk/impersonation/typo-squat/trusted-account and every other
     * one of the brand's own keywords are skipped entirely. Powers the
     * per-keyword start/stop toggle: the user wants "brand + this one
     * keyword," not the brand's full family sweep. `term`/`safe` (the
     * brand's own identity string, from brand.keywords[0] || brand.name)
     * is computed and used exactly as normal - only the custom-keyword
     * iteration list is narrowed to this single value.
     */
    onlyKeyword?: string;
    /**
     * Restricts onlyKeyword's query pair to just one search kind instead of
     * the normal repo-search + code-search pair - 'repositories' skips the
     * code-search half entirely, 'code' skips the repo-search half, 'both'
     * (default) emits both like before. Lets a user running the sequential
     * scheduler deliberately choose which GitHub search index a keyword's
     * turn spends its time on - e.g. code search's much tighter 10/min
     * ceiling means a keyword stuck waiting on it makes zero progress even
     * though repo search (30/min) still has headroom; skipping straight to
     * 'repositories' avoids that wait entirely instead of relying on queue
     * priority to merely de-prioritize it. Ignored outside onlyKeyword mode.
     */
    searchScope?: 'both' | 'repositories' | 'code';
  } = {},
): SearchQuerySpec[] {
  const maxQueries = options.maxQueries ?? 40;
  const searchScope = options.searchScope ?? 'both';
  const wantsRepoSearch = searchScope !== 'code';
  const wantsCodeSearch = searchScope !== 'repositories';
  const enableCodeSearch = options.enableCodeSearch !== false;
  const includeSecretFilenames =
    options.includeSecretFilenames !== false && !options.scopedToBrand;

  const specs: SearchQuerySpec[] = [];
  const seen = new Set<string>();

  // Filters that always AND together regardless of dateFilterMode - only
  // created:/pushed: ever have OR semantics between them.
  const baseFilters: string[] = [];
  if (process.env.GITHUB_SEARCH_LANGUAGE) {
    // e.g. "javascript" -> "language:javascript"
    const langs = process.env.GITHUB_SEARCH_LANGUAGE.split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    if (langs.length === 1) {
      baseFilters.push(`language:${langs[0]}`);
    } else if (langs.length > 1) {
      // GitHub supports multiple language filters in one search
      baseFilters.push(langs.map((l) => `language:${l}`).join(' OR '));
    }
  }
  if (process.env.GITHUB_SEARCH_STARS) {
    baseFilters.push(`stars:${process.env.GITHUB_SEARCH_STARS}`);
  }
  // An explicit per-scan date range always wins over the static env default -
  // the env var is a global fallback, not meant to override a deliberate,
  // one-off request for a specific window. Only relevant to the 'and' path
  // below (no explicit created qualifier at all) - buildDateQualifierVariants
  // doesn't know about this env fallback, it's a query-families-only concept.
  const hasExplicitCreated = Boolean(options.createdFrom || options.createdTo);
  const dateQualifiers = buildDateQualifierVariants(
    options.createdFrom,
    options.createdTo,
    options.pushedFrom,
    options.pushedTo,
    options.dateFilterMode,
  );

  // One suffix string per query variant to actually generate - normally
  // just one (AND everything together, or fall back to GITHUB_SEARCH_DATE
  // when no explicit created range was given), but two when 'or' mode
  // produced two independent qualifiers to choose between.
  let repoSuffixVariants: string[];
  if (dateQualifiers.length === 2) {
    repoSuffixVariants = dateQualifiers.map(
      (q) => ' ' + [...baseFilters, q].join(' '),
    );
  } else {
    const filters = [...baseFilters];
    if (dateQualifiers.length === 1) {
      filters.push(dateQualifiers[0]);
    } else if (!hasExplicitCreated && process.env.GITHUB_SEARCH_DATE) {
      filters.push(process.env.GITHUB_SEARCH_DATE);
    }
    repoSuffixVariants = [filters.length > 0 ? ' ' + filters.join(' ') : ''];
  }

  const push = (spec: SearchQuerySpec) => {
    if (spec.kind !== 'repositories') {
      // GitHub excludes forks by default from every search, code included.
      // A brand-impersonation clone is very often exactly a fork of some
      // legitimate template repackaged with the brand's stolen content
      // (login-page clones especially), so leaving forks out here was a
      // real, silent coverage gap for the one case this family of queries
      // exists to catch - not a deliberate noise-reduction choice the way
      // it might be for, say, a popularity-ranked repository-search result
      // page. `fork:true` INCLUDES forks alongside originals (not
      // fork-only), so this only ever adds coverage.
      const query =
        spec.kind === 'code' ? `${spec.query} fork:true` : spec.query;
      const key = `${spec.kind}:${query}`;
      if (seen.has(key) || query.length > 250) return;
      if (specs.length >= maxQueries) return;
      seen.add(key);
      specs.push({ ...spec, query });
      return;
    }
    // Repository search: one push() call becomes one query per date-filter
    // variant (normally 1, up to 2 in 'or' mode) - each a genuinely
    // distinct query string with its own dedup/budget accounting below.
    for (const suffix of repoSuffixVariants) {
      const query = `${spec.query}${suffix}`;
      const key = `repositories:${query}`;
      if (seen.has(key) || query.length > 250) continue;
      if (specs.length >= maxQueries) return;
      seen.add(key);
      specs.push({ ...spec, query });
    }
  };

  const activeKeywords: KeywordQueryInput[] =
    options.keywords && options.keywords.length > 0
      ? options.keywords.filter((k) => k.enabled !== false)
      : [
          { keyword: 'login', category: 'phishing', priority: 5 },
          { keyword: 'verification', category: 'phishing', priority: 5 },
          { keyword: 'wallet', category: 'phishing', priority: 5 },
          { keyword: 'payment', category: 'phishing', priority: 5 },
          { keyword: 'otp', category: 'phishing', priority: 5 },
          { keyword: 'apk', category: 'malware', priority: 5 },
          { keyword: 'mod', category: 'malware', priority: 5 },
          { keyword: 'stealer', category: 'malware', priority: 5 },
        ];

  const pick = (category: string, fallback: string[], limit = 5) => {
    const fromDb = topKeywordsByCategory(activeKeywords, category, limit);
    return fromDb.length > 0 ? fromDb : fallback;
  };

  for (const brand of brands) {
    const term = (brand.keywords[0] || brand.name || '').trim();
    if (!term) continue;
    const safe = term.replace(/"/g, '').slice(0, 40);
    // Repository search's plain (unqualified) terms - quoted so a
    // multi-word brand name is matched as one phrase. Code-search lines
    // below already quote `safe` directly; this is only for the
    // previously-bare repository-search occurrences.
    const safeTermPhrase = phraseify(safe);

    if (options.onlyKeyword) {
      const safeKeyword = options.onlyKeyword
        .replace(/"/g, '')
        .trim()
        .slice(0, 100);
      if (safeKeyword && safeKeyword.toLowerCase() !== safe.toLowerCase()) {
        // Deliberately searches the keyword ALONE, not AND-combined with the
        // brand's own term - a repo mentioning "kite trading" (say) is worth
        // finding whether or not it also happens to literally say "zerodha"
        // anywhere in its name/description. Requiring both was silently
        // dropping real matches: the per-keyword toggle exists precisely so
        // one specific, user-chosen keyword can be searched on its own
        // merits, the same way typing it into github.com's own search box
        // would (matches name, description, topics AND README - see the
        // self-referential branch below for why no in:name,description
        // qualifier either).
        if (wantsRepoSearch) {
          push({
            kind: 'repositories',
            family: 'brand-keyword-custom',
            query: phraseify(safeKeyword),
          });
        }
        if (enableCodeSearch && wantsCodeSearch) {
          push({
            kind: 'code',
            family: 'brand-keyword-custom-code',
            query: `"${safeKeyword}"`,
          });
        }
      } else if (safeKeyword) {
        // The toggled keyword IS the brand's own identity term (safe) -
        // search for it alone instead of producing zero queries, which
        // would otherwise make this keyword's scan complete instantly with
        // no results and flip its toggle back to "off" with no explanation.
        // Deliberately unqualified (no in:name,description) - that's the one
        // case where this query is meant to mirror a plain "<term>" search
        // typed into github.com's own search box, which matches name,
        // description, topics AND README content. Restricting to
        // in:name,description here made this keyword's toggle systematically
        // undershoot github.com's own result count for the exact same term.
        if (wantsRepoSearch) {
          push({
            kind: 'repositories',
            family: 'brand-keyword-custom',
            query: safeTermPhrase,
          });
        }
        if (enableCodeSearch && wantsCodeSearch) {
          push({
            kind: 'code',
            family: 'brand-keyword-custom-code',
            query: `"${safe}"`,
          });
        }
      }
      continue;
    }

    // Dynamic Phishing Search — highest-priority phishing keywords from DB.
    // Widening this to 4 (from 2) is free in query-budget terms: these all
    // OR together into the SAME single query rather than becoming separate
    // pushes, so it surfaces more of a curated list without costing extra
    // GitHub search requests - the only limit that matters here is staying
    // well under push()'s 250-char query cap, which a handful of short
    // keyword terms comfortably does.
    const phishingKws = pick('phishing', ['phishing', 'login'], 4);
    push({
      kind: 'repositories',
      family: 'phishing',
      query: `${safeTermPhrase} (${phishingKws.join(' OR ')}) in:name,description`,
    });

    // Dynamic Malware / APK Search — highest-priority malware keywords from DB
    const malwareKws = pick('malware', ['apk', 'stealer'], 4);
    push({
      kind: 'repositories',
      family: 'apk',
      query: `${safeTermPhrase} (${malwareKws.join(' OR ')}) in:name,description`,
    });

    // Brand impersonation / generic clone search. Parenthesized like the
    // phishing/malware OR-groups above - without the parens, GitHub reads
    // "X clone OR spoof OR fake OR unofficial" as "(X AND clone) OR spoof OR
    // fake OR unofficial", which matches ANY repo containing just the bare
    // word "fake"/"spoof"/"unofficial" ANYWHERE, with no brand connection
    // at all - the opposite of what this family is for.
    push({
      kind: 'repositories',
      family: 'impersonation',
      query: `${safeTermPhrase} (clone OR spoof OR fake OR unofficial) in:name,description`,
    });

    // Typo-squat
    for (const variant of generateTypoVariants(safe, 3)) {
      push({
        kind: 'repositories',
        family: 'typo-squat',
        query: `${variant} in:name`,
      });
    }

    // This brand's own user-curated "Search keywords" (Companies/Brand page)
    // - every one of them, not just keywords[0] (which only ever supplies
    // `term` above). Each is paired with the brand term for precision, since
    // a bare keyword alone ("otp", "trading") is far too generic to search
    // GitHub for on its own. customKeywordMatchRule (threat.rules.ts) is what
    // later reports exactly which keyword actually matched and where.
    //
    // Sized for a real, deliberately comprehensive curated list (brand name
    // variants, product names, exec names, domains, social handles - 60+ is
    // a realistic size), not just a handful of risk terms - the actual
    // ceiling on how many really get searched is the shared `maxQueries`
    // budget below, same as every other family.
    const MAX_CUSTOM_KEYWORDS_PER_BRAND = 100;
    const customKeywords = dedupeKeywordsCaseInsensitive(brand.keywords)
      .map((k) => k.replace(/"/g, '').trim().slice(0, 100))
      .filter((k) => k && k.toLowerCase() !== safe.toLowerCase())
      .slice(0, MAX_CUSTOM_KEYWORDS_PER_BRAND);
    for (const safeKeyword of customKeywords) {
      // GitHub repo names can never contain a "/" (it's the owner/repo
      // separator) - a URL or path-shaped keyword ("https://x.com/...")
      // can therefore never match a repo's *name*, only its free-text
      // description. Dropping `in:name` for these isn't just cosmetic: it's
      // an honest statement of what this query can actually match, and it's
      // still a real, useful description search - not skipped entirely.
      const inQualifier = safeKeyword.includes('/')
        ? 'in:description'
        : 'in:name,description';
      // Quoted as an exact phrase - unquoted, GitHub treats a multi-word
      // keyword like "otp bypass" as two independent terms that can match
      // anywhere, in any order, unrelated to each other. A quoted phrase
      // only matches the words together, in that order, which is what
      // "search for this exact keyword" actually means.
      push({
        kind: 'repositories',
        family: 'brand-keyword-custom',
        query: `${safeTermPhrase} "${safeKeyword}" ${inQualifier}`,
      });
    }

    if (enableCodeSearch) {
      // Same OR-widening as phishing/malware above - still one query, more
      // of the curated secret-category list actually gets searched for.
      const secretKws = pick('secret', ['AKIA', 'ghp_'], 4);
      push({
        kind: 'code',
        family: 'brand-secret',
        query: `"${safe}" (${secretKws.join(' OR ')})`,
      });

      // Same custom keywords as the repo-search bait above, but searched as
      // CODE - GitHub's code search indexes actual file content (any path,
      // any depth), not just the repo's own name/description. This is what
      // catches a keyword buried in e.g. backend/src/main.py that never
      // shows up anywhere in the repo's metadata. Still subject to GitHub
      // code search's own limits (350KB per file, default branch only,
      // vendored/generated paths excluded) - see customKeywordMatchRule for
      // what happens once a repo found this way is actually investigated.
      for (const safeKeyword of customKeywords) {
        push({
          kind: 'code',
          family: 'brand-keyword-custom-code',
          query: `"${safe}" "${safeKeyword}"`,
        });
      }

      // Distinctive-content bait: exact-phrase code search for rare strings
      // pulled from the brand's own content. Capped small (unlike the
      // static secret-filename list) since each phrase is its own query and
      // the maxQueries budget is shared across every family.
      for (const phrase of (brand.distinctivePhrases || []).slice(0, 5)) {
        const safePhrase = phrase.replace(/"/g, '').trim();
        if (!safePhrase) continue;
        push({
          kind: 'code',
          family: 'distinctive-content',
          query: `"${safePhrase}"`,
        });
      }
    }

    // Unconditional sweep of this brand's own known GitHub accounts - every
    // public repo they own, regardless of whether its name/content happens
    // to match a keyword or secret pattern. This is what actually catches
    // "we forgot to make this internal repo private" - the other query
    // families above only find repos that already look suspicious or
    // already mention a secret pattern; this one doesn't need either.
    // Queried as both org: and user: since which qualifier applies depends
    // on the account type and callers may not know it - the wrong one just
    // returns zero results.
    for (const owner of brand.trustedGithubOwners || []) {
      const safeOwner = owner.replace(/["\s]/g, '').slice(0, 40);
      if (!safeOwner) continue;
      push({
        kind: 'repositories',
        family: 'trusted-account',
        query: `org:${safeOwner}`,
      });
      push({
        kind: 'repositories',
        family: 'trusted-account',
        query: `user:${safeOwner}`,
      });
    }
  }

  // Brand-agnostic searches using high-priority brand-category keywords -
  // the workspace's global Keywords list, NOT necessarily the brand(s) this
  // scan is scoped to (see scopedToBrand above). Unlike the OR-widened
  // families above, each of these becomes its own separate query below - so
  // raising this limit (3 -> 5) does add real extra GitHub search requests,
  // not just a broader single query.
  if (!options.scopedToBrand) {
    const brandKws = pick('brand', [], 5);
    for (const kw of brandKws) {
      push({
        kind: 'repositories',
        family: 'brand-keyword',
        query: `${kw} (login OR apk OR phishing) in:name,description`,
      });
    }
  }

  // Brand-agnostic filename / secret discovery (static + dynamic from secret keywords)
  if (includeSecretFilenames) {
    if (enableCodeSearch) {
      const staticQueries = [
        'filename:.env AKIA',
        'filename:.env ghp_',
        'filename:credentials.json',
        'filename:firebase.json',
        'filename:google-services.json',
        'filename:serviceAccount.json',
        'filename:id_rsa',
        'extension:pem BEGIN PRIVATE',
        'sk_live_ filename:.env',
      ];
      for (const q of staticQueries) {
        push({ kind: 'code', family: 'secret-filename', query: q });
      }
      // Dynamic secret-filename queries from DB secret-category keywords.
      // Also a separate-query-per-keyword loop, same real-request tradeoff
      // as brandKws above (4 -> 6).
      const secretKws = pick('secret', [], 6);
      for (const kw of secretKws) {
        push({
          kind: 'code',
          family: 'secret-filename',
          query: `filename:.env ${kw}`,
        });
      }
    } else {
      const secretTerms = pick(
        'secret',
        ['dotenv', 'credentials', 'private key'],
        5,
      );
      push({
        kind: 'repositories',
        family: 'secret-filename',
        query: `${secretTerms.join(' OR ')} in:name,description`,
      });
    }
  }

  return specs.slice(0, maxQueries);
}
