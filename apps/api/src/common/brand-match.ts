import { jaroWinkler } from './utils/string-similarity';
import { findAliasWordMatch } from './utils/word-match.util';

/**
 * "This mentions the brand name" is not the same claim depending on where it
 * was found. A verified trusted-owner match is a known fact; an exact
 * substring in the repo's own name/description is strong; a fuzzy word match
 * buried in a file or a commit message is real but weaker evidence someone
 * should be able to see and judge for themselves rather than just trusting
 * a bare "brandName" label.
 */
export type BrandMatchType = 'trusted_owner' | 'exact' | 'fuzzy';

export type BrandMatchLocation =
  | 'owner'
  | 'repo_name'
  | 'description'
  | 'topics'
  | 'file_path'
  | 'readme'
  | 'file_content'
  | 'commit_message'
  | 'commit_author';

export interface BrandMatchEvidence {
  type: BrandMatchType;
  location: BrandMatchLocation;
  /** The brand name/alias string that matched. */
  matchedAlias: string;
  /** A short excerpt of the actual text it was found in. */
  matchedText: string;
  /** Which file the match was found in - set only when location is 'file_content'. */
  filePath?: string;
  /** 1-indexed line the match was found on - set only when location is 'readme' or 'file_content', so an analyst can jump straight to it instead of re-searching a whole file. */
  lineNumber?: number;
}

export interface BrandMatchInput {
  name: string;
  aliases: string[];
  trustedGithubOwners?: string[];
}

export interface BrandMatchSources {
  ownerLogin?: string;
  repoName: string;
  description: string;
  topics: string[];
  /**
   * Every file/folder path in the repo tree (not just the capped subset
   * whose content gets fetched) - lets a brand name buried in a deep
   * directory or filename (`assets/logos/paypal-icon.svg`,
   * `src/scrapers/netflix_scraper.py`) surface as evidence even when
   * nothing ever reads that file's content.
   */
  filePaths?: string[];
  readmeText?: string;
  fileTexts?: Array<{ path: string; content: string }>;
  commitMessages?: string[];
  commitAuthors?: string[];
  /**
   * Every (alias, file, line) exact hit from a full-repo `git grep` over the
   * WHOLE cloned tree - not just the small subset of files whose content
   * happened to get fetched for secret-scanning (`fileTexts` above). When
   * present, this is the source of 'file_content' evidence instead, since it
   * actually covers every file in the repo rather than a priority sample.
   */
  fullRepoTextMatches?: Array<{
    alias: string;
    path: string;
    lineNumber: number;
    line: string;
  }>;
}

const FUZZY_THRESHOLD = 0.85;
const MIN_TOKEN_LENGTH = 3;
const SNIPPET_RADIUS = 40;

/**
 * A genuine typosquat is a near-identical-LENGTH near-miss of the real
 * brand name (angelon/angelone, angleone/angelone - off by 0-1
 * insertions/deletions). Jaro-Winkler alone doesn't enforce that: it scores
 * shared characters and a common prefix regardless of how different the two
 * strings' overall lengths are, so a short, completely unrelated common word
 * can drift over FUZZY_THRESHOLD purely by sharing a couple of letters with
 * a longer brand name - e.g. "anon" (from a Supabase env var,
 * VITE_SUPABASE_ANON_KEY) scores 0.867 against "angelone" (shares the
 * "an" prefix plus stray o/n matches), clearing 0.85 with zero semantic
 * relationship to the brand at all. Capping how far apart the two lengths
 * are allowed to be keeps the fuzzy pass doing what it's actually for
 * (catching close typos) without opening the door to short, generic
 * programming terms coincidentally resembling a longer brand name.
 */
const MAX_FUZZY_LENGTH_DIFF = 2;

function fuzzyMatches(token: string, alias: string): boolean {
  if (Math.abs(token.length - alias.length) > MAX_FUZZY_LENGTH_DIFF) {
    return false;
  }
  return jaroWinkler(token, alias) >= FUZZY_THRESHOLD;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_TOKEN_LENGTH);
}

function snippetAroundIndex(
  haystack: string,
  index: number,
  length: number,
): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(haystack.length, index + length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end).trim()}${end < haystack.length ? '…' : ''}`;
}

function snippetAround(haystack: string, needle: string): string {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return haystack.slice(0, 80).trim();
  return snippetAroundIndex(haystack, idx, needle.length);
}

interface SourceEntry {
  text: string;
  /** Only set for file_content entries - which file this text came from. */
  path?: string;
}

/**
 * README and file content can be hundreds of lines - a whole-blob snippet
 * doesn't tell an analyst where to look. Everything else here (repo name,
 * description, a single topic, a commit message/author) is already a short,
 * single-value field, so a line number would be meaningless noise on top of
 * it - the value itself IS the exact location.
 */
const MULTILINE_LOCATIONS = new Set<BrandMatchLocation>([
  'readme',
  'file_content',
]);

/** Ordered strongest-evidence-first; the caller stops at the first hit. */
function orderedSources(
  sources: BrandMatchSources,
): Array<[BrandMatchLocation, SourceEntry[]]> {
  return [
    ['repo_name', [{ text: sources.repoName }]],
    ['description', [{ text: sources.description }]],
    ['topics', sources.topics.map((t) => ({ text: t }))],
    ['file_path', (sources.filePaths || []).map((p) => ({ text: p }))],
    ['readme', sources.readmeText ? [{ text: sources.readmeText }] : []],
    [
      'file_content',
      (sources.fileTexts || []).map((f) => ({ text: f.content, path: f.path })),
    ],
    [
      'commit_message',
      (sources.commitMessages || []).map((m) => ({ text: m })),
    ],
    ['commit_author', (sources.commitAuthors || []).map((a) => ({ text: a }))],
  ];
}

function matchLinesExact(
  content: string,
  aliases: string[],
): { hit: string; lineNumber: number; snippet: string } | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const found = findAliasWordMatch(lines[i], aliases);
    if (found) {
      return {
        hit: found.alias,
        lineNumber: i + 1,
        snippet: snippetAroundIndex(lines[i], found.index, found.alias.length),
      };
    }
  }
  return null;
}

function matchLinesFuzzy(
  content: string,
  aliases: string[],
): { hit: string; lineNumber: number; snippet: string } | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const token of tokenize(lines[i])) {
      const hit = aliases.find((a) => fuzzyMatches(token, a));
      if (hit)
        return {
          hit,
          lineNumber: i + 1,
          snippet: snippetAround(lines[i], token),
        };
    }
  }
  return null;
}

/**
 * Answers "how do we actually know this belongs to this brand" - checks
 * every available source from strongest to weakest evidence and returns
 * the first (strongest) hit, rather than every match, so an analyst gets
 * one clear, specific, checkable reason instead of a noisy list. Exact
 * substring matches are checked across every source before any fuzzy match
 * is considered, since exact evidence anywhere outranks a fuzzy hit
 * anywhere else.
 */
export function findBrandMatch(
  brand: BrandMatchInput,
  sources: BrandMatchSources,
  options: { exactOnly?: boolean } = {},
): BrandMatchEvidence | null {
  const aliases = [brand.name, ...brand.aliases]
    .filter(Boolean)
    .map((a) => a.toLowerCase());
  if (aliases.length === 0) return null;

  if (sources.ownerLogin && (brand.trustedGithubOwners || []).length > 0) {
    const owner = sources.ownerLogin.toLowerCase();
    const trustedMatch = (brand.trustedGithubOwners || []).find(
      (o) => o.toLowerCase() === owner,
    );
    if (trustedMatch) {
      return {
        type: 'trusted_owner',
        location: 'owner',
        matchedAlias: trustedMatch,
        matchedText: sources.ownerLogin,
      };
    }
  }

  const sourceList = orderedSources(sources);

  for (const [location, entries] of sourceList) {
    // A full-repo `git grep` (when the clone-scan path ran) already covers
    // every file in the tree, not just the small maxFiles sample `entries`
    // is built from here - if it found something, that's strictly more
    // complete evidence than re-scanning the sample, so it takes over the
    // 'file_content' slot in the strength ordering rather than re-deriving
    // the same thing from a partial view.
    if (location === 'file_content') {
      // Word-boundary filtering for this source (rejecting "fyers" buried
      // inside "identifyers") happens once, upstream, at the actual grep
      // call - see CloneScanService.grepBrandMentions/grepCustomKeywords -
      // rather than re-verified again here, so a match's `alias` string is
      // trusted as-is once it's already in this array.
      const fullRepoHit = (sources.fullRepoTextMatches || []).find((m) =>
        aliases.includes(m.alias.toLowerCase()),
      );
      if (fullRepoHit) {
        return {
          type: 'exact',
          location: 'file_content',
          matchedAlias: fullRepoHit.alias,
          matchedText: snippetAround(fullRepoHit.line, fullRepoHit.alias),
          filePath: fullRepoHit.path,
          lineNumber: fullRepoHit.lineNumber,
        };
      }
    }
    for (const entry of entries) {
      if (!entry.text) continue;
      if (MULTILINE_LOCATIONS.has(location)) {
        const found = matchLinesExact(entry.text, aliases);
        if (found) {
          return {
            type: 'exact',
            location,
            matchedAlias: found.hit,
            matchedText: found.snippet,
            filePath: entry.path,
            lineNumber: found.lineNumber,
          };
        }
        continue;
      }
      const found = findAliasWordMatch(entry.text, aliases);
      if (found) {
        return {
          type: 'exact',
          location,
          matchedAlias: found.alias,
          matchedText: snippetAroundIndex(
            entry.text,
            found.index,
            found.alias.length,
          ),
        };
      }
    }
  }

  if (options.exactOnly) return null;

  // Fuzzy pass only runs once every source has failed an exact check -
  // compares individual words, not the whole text, since Jaro-Winkler only
  // means something for two similarly-short strings.
  for (const [location, entries] of sourceList) {
    for (const entry of entries) {
      if (!entry.text) continue;
      if (MULTILINE_LOCATIONS.has(location)) {
        const found = matchLinesFuzzy(entry.text, aliases);
        if (found) {
          return {
            type: 'fuzzy',
            location,
            matchedAlias: found.hit,
            matchedText: found.snippet,
            filePath: entry.path,
            lineNumber: found.lineNumber,
          };
        }
        continue;
      }
      for (const token of tokenize(entry.text)) {
        const hit = aliases.find((a) => fuzzyMatches(token, a));
        if (hit) {
          return {
            type: 'fuzzy',
            location,
            matchedAlias: hit,
            matchedText: snippetAround(entry.text, token),
          };
        }
      }
    }
  }

  return null;
}

const MATCH_STRENGTH: Record<BrandMatchType, number> = {
  trusted_owner: 3,
  exact: 2,
  fuzzy: 1,
};

/**
 * repo_name/description/topics/file_path/owner are the repo author's own
 * deliberate words about their own project - a match there is real signal.
 * readme/file_content/commit_message/commit_author are much noisier: a
 * one-word brand alias like "google" showing up in a README badge, a
 * "Sign in with Google" button, or a `google-services.json` filename is
 * completely routine SDK/API integration, not evidence the repo is about
 * Google. Ranked as its own tier, ahead of match type, so a genuine (even
 * if only fuzzy/typo'd) hit in the repo's own name/description doesn't lose
 * to some other, unrelated brand's incidental exact mention buried in a
 * file - see brand-match "why do I get Google when I search for AngelOne"
 * bug this tiering exists to fix.
 */
const STRONG_LOCATIONS = new Set<BrandMatchLocation>([
  'owner',
  'repo_name',
  'description',
  'topics',
  'file_path',
]);

function matchRank(
  evidence: BrandMatchEvidence,
): [locationTier: number, typeTier: number] {
  return [
    STRONG_LOCATIONS.has(evidence.location) ? 1 : 0,
    MATCH_STRENGTH[evidence.type],
  ];
}

function isStrongerMatch(
  candidate: BrandMatchEvidence,
  current: BrandMatchEvidence,
): boolean {
  const [candLoc, candType] = matchRank(candidate);
  const [curLoc, curType] = matchRank(current);
  if (candLoc !== curLoc) return candLoc > curLoc;
  return candType > curType;
}

/**
 * Runs `findBrandMatch` against every monitored brand (not just the one that
 * happened to superficially match at discovery time) and keeps the
 * strongest hit. This is what lets a repo whose brand mention is buried
 * only in deep file content - never in its own name/description/topics -
 * still get attributed to the right brand once the full-repo scan has run,
 * instead of staying forever unmatched because the shallow, pre-clone check
 * picked nothing.
 */
export function findBestBrandMatch<T extends BrandMatchInput>(
  brands: T[],
  sources: BrandMatchSources,
): { brand: T; evidence: BrandMatchEvidence } | null {
  let best: { brand: T; evidence: BrandMatchEvidence } | null = null;
  for (const brand of brands) {
    const evidence = findBrandMatch(brand, sources);
    if (!evidence) continue;
    if (!best || isStrongerMatch(evidence, best.evidence)) {
      best = { brand, evidence };
    }
  }
  return best;
}

export interface KeywordMatch {
  /** The exact keyword string as the analyst entered it. */
  keyword: string;
  evidence: BrandMatchEvidence;
}

/**
 * Same "where exactly did this come from" machinery as findBrandMatch, reused
 * for a brand's own user-curated "Search keywords" (set on the Companies/Brand
 * page) instead of its name/aliases. Each keyword is treated as its own
 * single-alias "brand" so every hit gets full evidence (type, location, file
 * path, line number) - not just a yes/no. Unlike findBrandMatch, this returns
 * every distinct keyword that hit (up to maxMatches), not just the strongest,
 * since the point here is telling the analyst exactly which of *their own*
 * terms showed up, not picking one winner.
 *
 * Exact matches only - unlike brand name/alias matching, a fuzzy (typo-
 * tolerant) hit on an arbitrary curated keyword isn't a meaningful claim.
 * "Zerodha" fuzzy-matching "Zerodhaa" is a real typosquat signal; "otp"
 * fuzzy-matching some unrelated word is just noise reported as if it were
 * the analyst's own literal term.
 */
export function findKeywordMatches(
  keywords: string[],
  sources: BrandMatchSources,
  maxMatches = 5,
): KeywordMatch[] {
  const results: KeywordMatch[] = [];
  for (const raw of keywords) {
    if (results.length >= maxMatches) break;
    const keyword = raw.trim();
    if (!keyword) continue;
    const evidence = findBrandMatch({ name: keyword, aliases: [] }, sources, {
      exactOnly: true,
    });
    if (evidence) results.push({ keyword, evidence });
  }
  return results;
}
