import { generateTypoVariants } from './typo-squat';

export type SearchKind = 'repositories' | 'code';

export interface SearchQuerySpec {
  query: string;
  kind: SearchKind;
  family: string;
}

export interface BrandQueryInput {
  name: string;
  aliases: string[];
  keywords: string[];
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
  } = {},
): SearchQuerySpec[] {
  const maxQueries = options.maxQueries ?? 40;
  const enableCodeSearch = options.enableCodeSearch !== false;
  const includeSecretFilenames = options.includeSecretFilenames !== false;

  const specs: SearchQuerySpec[] = [];
  const seen = new Set<string>();

  // Load filters from env or config
  const filters: string[] = [];
  if (process.env.GITHUB_SEARCH_LANGUAGE) {
    // e.g. "javascript" -> "language:javascript"
    const langs = process.env.GITHUB_SEARCH_LANGUAGE.split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    if (langs.length === 1) {
      filters.push(`language:${langs[0]}`);
    } else if (langs.length > 1) {
      // GitHub supports multiple language filters in one search
      filters.push(langs.map((l) => `language:${l}`).join(' OR '));
    }
  }
  if (process.env.GITHUB_SEARCH_STARS) {
    filters.push(`stars:${process.env.GITHUB_SEARCH_STARS}`);
  }
  if (process.env.GITHUB_SEARCH_DATE) {
    filters.push(process.env.GITHUB_SEARCH_DATE);
  }
  const suffixFilters = filters.length > 0 ? ' ' + filters.join(' ') : '';

  const push = (spec: SearchQuerySpec) => {
    // Append filters to repository searches
    if (spec.kind === 'repositories') {
      spec.query = `${spec.query}${suffixFilters}`;
    }
    const key = `${spec.kind}:${spec.query}`;
    if (seen.has(key) || spec.query.length > 250) return;
    if (specs.length >= maxQueries) return;
    seen.add(key);
    specs.push(spec);
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

    // Dynamic Phishing Search — highest-priority phishing keywords from DB
    const phishingKws = pick('phishing', ['phishing', 'login'], 2);
    push({
      kind: 'repositories',
      family: 'phishing',
      query: `${safe} (${phishingKws.join(' OR ')}) in:name,description`,
    });

    // Dynamic Malware / APK Search — highest-priority malware keywords from DB
    const malwareKws = pick('malware', ['apk', 'stealer'], 2);
    push({
      kind: 'repositories',
      family: 'apk',
      query: `${safe} (${malwareKws.join(' OR ')}) in:name,description`,
    });

    // Brand impersonation / generic clone search
    push({
      kind: 'repositories',
      family: 'impersonation',
      query: `${safe} clone OR spoof OR fake OR unofficial in:name,description`,
    });

    // Typo-squat
    for (const variant of generateTypoVariants(safe, 3)) {
      push({
        kind: 'repositories',
        family: 'typo-squat',
        query: `${variant} in:name`,
      });
    }

    if (enableCodeSearch) {
      const secretKws = pick('secret', ['AKIA', 'ghp_'], 2);
      push({
        kind: 'code',
        family: 'brand-secret',
        query: `${safe} (${secretKws.join(' OR ')})`,
      });
    }
  }

  // Brand-agnostic searches using high-priority brand-category keywords
  const brandKws = pick('brand', [], 3);
  for (const kw of brandKws) {
    push({
      kind: 'repositories',
      family: 'brand-keyword',
      query: `${kw} (login OR apk OR phishing) in:name,description`,
    });
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
      // Dynamic secret-filename queries from DB secret-category keywords
      const secretKws = pick('secret', [], 4);
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
        3,
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
