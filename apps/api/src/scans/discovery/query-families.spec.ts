import { BadRequestException } from '@nestjs/common';
import {
  CODE_SEARCH_SPLIT_LANGUAGES,
  buildCreatedQualifier,
  buildDateQualifierVariants,
  buildLanguageSplitQueries,
  buildPushedQualifier,
  buildQueryFamilies,
  ensureBoundedCreatedRange,
  ensureBoundedSizeRange,
  groupTopPhrasesByBrand,
  splitCreatedRangeQuery,
  splitSizeRangeQuery,
} from './query-families';
import { generateTypoVariants } from './typo-squat';

describe('discovery query families', () => {
  it('includes brand families, typo-squats, and secret filename hunts', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'PhonePe',
          aliases: ['phonepe'],
          keywords: ['phonepe'],
        },
      ],
      { maxQueries: 40, enableCodeSearch: true },
    );

    const families = new Set(specs.map((s) => s.family));
    expect(families.has('apk')).toBe(true);
    expect(families.has('phishing')).toBe(true);
    expect(families.has('impersonation')).toBe(true);
    expect(families.has('typo-squat')).toBe(true);
    expect(families.has('secret-filename')).toBe(true);
    expect(specs.some((s) => s.kind === 'code')).toBe(true);
    expect(specs.every((s) => s.query.length <= 250)).toBe(true);
  });

  it('suppresses both brand-agnostic families (secret-filename, brand-keyword) when scoped to a specific brand', () => {
    // Regression: a scan explicitly scoped to one brand was still silently
    // pulling in unrelated repos via the secret-filename sweep (searches
    // ALL of GitHub for .env/AKIA/credentials.json, zero brand relevance)
    // and the brand-keyword sweep (uses the workspace's global "brand"
    // -category Keywords list, which can include OTHER monitored brands) -
    // each producing a Finding with no brand attribution at all, since
    // secretDetectionRule/phishingRule/malwareRule fire on pure content
    // patterns with no brand match required.
    const specs = buildQueryFamilies(
      [{ name: 'PhonePe', aliases: ['phonepe'], keywords: ['phonepe'] }],
      {
        maxQueries: 40,
        enableCodeSearch: true,
        keywords: [{ keyword: 'google', category: 'brand', priority: 8 }],
        scopedToBrand: true,
      },
    );

    const families = new Set(specs.map((s) => s.family));
    expect(families.has('secret-filename')).toBe(false);
    expect(families.has('brand-keyword')).toBe(false);
    // The scoped brand's own per-brand families are untouched.
    expect(families.has('phishing')).toBe(true);
    expect(families.has('apk')).toBe(true);
    expect(families.has('typo-squat')).toBe(true);
  });

  it('still includes brand-agnostic families when not scoped to a specific brand', () => {
    const specs = buildQueryFamilies(
      [{ name: 'PhonePe', aliases: ['phonepe'], keywords: ['phonepe'] }],
      {
        maxQueries: 40,
        enableCodeSearch: true,
        keywords: [{ keyword: 'google', category: 'brand', priority: 8 }],
      },
    );

    const families = new Set(specs.map((s) => s.family));
    expect(families.has('secret-filename')).toBe(true);
    expect(families.has('brand-keyword')).toBe(true);
  });

  it('builds a brand-keyword-custom query for every configured keyword, not just the first', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha', 'otp bypass', 'kyc fraud'],
        },
      ],
      { maxQueries: 40 },
    );
    const customKeywordQueries = specs.filter(
      (s) => s.family === 'brand-keyword-custom',
    );
    // keywords[0] ("zerodha") is already the base term - skipped so it
    // doesn't produce a redundant "zerodha zerodha" query.
    expect(customKeywordQueries.map((s) => s.query)).toEqual([
      'zerodha "otp bypass" in:name,description',
      'zerodha "kyc fraud" in:name,description',
    ]);
  });

  it('collapses case-only duplicate keywords into a single query instead of one per variant', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          // "zerodha" (index 0, becomes the base term) and "Zerodha" (index
          // 2) are the same word - only "Kite" should produce a query.
          aliases: ['zerodha'],
          keywords: ['zerodha', 'Zerodha', 'Kite'],
        },
      ],
      { maxQueries: 40 },
    );
    const customKeywordQueries = specs.filter(
      (s) => s.family === 'brand-keyword-custom',
    );
    expect(customKeywordQueries.map((s) => s.query)).toEqual([
      'zerodha "Kite" in:name,description',
    ]);
  });

  it('scopes URL/path-shaped keywords to in:description only, since a repo name can never contain a "/"', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: [
            'zerodha',
            'otp bypass',
            'https://x.com/zerodhaonline/',
            'zerodha.com',
          ],
        },
      ],
      { maxQueries: 40 },
    );
    const customKeywordQueries = specs.filter(
      (s) => s.family === 'brand-keyword-custom',
    );
    expect(customKeywordQueries.map((s) => s.query)).toEqual([
      'zerodha "otp bypass" in:name,description',
      // Contains "/" - can never match a repo *name* (GitHub reserves "/"
      // as the owner/repo separator) - scoped to description only.
      'zerodha "https://x.com/zerodhaonline/" in:description',
      // No "/" - a bare domain like this can technically appear in a repo
      // name, so it keeps the full in:name,description search.
      'zerodha "zerodha.com" in:name,description',
    ]);
  });

  it('still searches URL/path-shaped keywords as code - file content has no name restriction', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha', 'https://x.com/zerodhaonline/'],
        },
      ],
      { maxQueries: 40, enableCodeSearch: true },
    );
    const codeKeywordQueries = specs.filter(
      (s) => s.family === 'brand-keyword-custom-code',
    );
    expect(codeKeywordQueries.map((s) => s.query)).toEqual([
      '"zerodha" "https://x.com/zerodhaonline/" fork:true',
    ]);
  });

  it('also searches custom keywords as code (file content, not just repo metadata)', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha', 'otp bypass'],
        },
      ],
      { maxQueries: 40, enableCodeSearch: true },
    );
    const codeKeywordQueries = specs.filter(
      (s) => s.family === 'brand-keyword-custom-code',
    );
    expect(codeKeywordQueries).toEqual([
      {
        kind: 'code',
        family: 'brand-keyword-custom-code',
        query: '"zerodha" "otp bypass" fork:true',
      },
    ]);
  });

  it('skips the code-search custom-keyword family when code search is disabled', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha', 'otp bypass'],
        },
      ],
      { maxQueries: 40, enableCodeSearch: false },
    );
    expect(specs.some((s) => s.family === 'brand-keyword-custom-code')).toBe(
      false,
    );
  });

  it('does not cap a realistic large curated keyword list at just a handful', () => {
    // A real brand can have 60+ curated terms (name variants, products,
    // execs, domains) - this must not silently truncate to a small number.
    const keywords = Array.from({ length: 60 }, (_, i) => `term${i}`);
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: ['acme'], keywords: ['acme', ...keywords] }],
      { maxQueries: 500 },
    );
    const customKeywordQueries = specs.filter(
      (s) => s.family === 'brand-keyword-custom',
    );
    expect(customKeywordQueries).toHaveLength(60);
  });

  it('caps custom-keyword queries at 100 per brand as a sanity ceiling', () => {
    const keywords = Array.from({ length: 150 }, (_, i) => `term${i}`);
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: ['acme'], keywords: ['acme', ...keywords] }],
      { maxQueries: 500 },
    );
    const customKeywordQueries = specs.filter(
      (s) => s.family === 'brand-keyword-custom',
    );
    expect(customKeywordQueries).toHaveLength(100);
  });

  it('respects maxQueries budget', () => {
    const brands = Array.from({ length: 20 }, (_, i) => ({
      name: `Brand${i}`,
      aliases: [`brand${i}`],
      keywords: [`brand${i}`],
    }));
    const specs = buildQueryFamilies(brands, { maxQueries: 15 });
    expect(specs.length).toBeLessThanOrEqual(15);
  });

  it('prefers higher-priority keywords from the DB per category', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      {
        maxQueries: 40,
        enableCodeSearch: true,
        keywords: [
          // Five phishing-category keywords against a per-category limit of
          // 4 (see phishingKws in query-families.ts), so the lowest-priority
          // one is still the one bumped off the top-N cut.
          { keyword: 'low-priority', category: 'phishing', priority: 2 },
          { keyword: 'high-priority', category: 'phishing', priority: 9 },
          { keyword: 'mid-priority-a', category: 'phishing', priority: 6 },
          { keyword: 'mid-priority-b', category: 'phishing', priority: 5 },
          { keyword: 'mid-priority-c', category: 'phishing', priority: 4 },
          { keyword: 'secret-token', category: 'secret', priority: 10 },
          { keyword: 'old-secret', category: 'secret', priority: 3 },
        ],
      },
    );

    const phishing = specs.find((s) => s.family === 'phishing');
    expect(phishing?.query).toContain('high-priority');
    expect(phishing?.query).not.toContain('low-priority');

    const brandSecret = specs.find((s) => s.family === 'brand-secret');
    expect(brandSecret?.query).toContain('secret-token');

    expect(
      specs.some(
        (s) =>
          s.family === 'secret-filename' && s.query.includes('secret-token'),
      ),
    ).toBe(true);
  });

  it('skips disabled keywords', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      {
        keywords: [
          {
            keyword: 'enabled-kw',
            category: 'phishing',
            priority: 9,
            enabled: true,
          },
          {
            keyword: 'disabled-kw',
            category: 'phishing',
            priority: 10,
            enabled: false,
          },
        ],
      },
    );
    const phishing = specs.find((s) => s.family === 'phishing');
    expect(phishing?.query).toContain('enabled-kw');
    expect(phishing?.query).not.toContain('disabled-kw');
  });
});

describe('code search includes forks', () => {
  // GitHub excludes forks from every search by default - an impersonation
  // clone is very often exactly a fork of some legitimate template
  // repackaged with the brand's stolen content, so every code-search query
  // this codebase generates should opt back in with fork:true. Repository
  // search is deliberately left alone (out of scope for this fix).
  it('appends fork:true to every code-search family, brand-scoped and brand-agnostic alike', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Acme',
          aliases: [],
          keywords: ['acme'],
          distinctivePhrases: ['A rare distinctive phrase about Acme'],
        },
      ],
      { maxQueries: 100, enableCodeSearch: true, includeSecretFilenames: true },
    );
    const codeSpecs = specs.filter((s) => s.kind === 'code');
    expect(codeSpecs.length).toBeGreaterThan(0);
    expect(codeSpecs.every((s) => s.query.endsWith('fork:true'))).toBe(true);

    const families = new Set(codeSpecs.map((s) => s.family));
    expect(families).toEqual(
      new Set(['brand-secret', 'distinctive-content', 'secret-filename']),
    );
  });

  it('never appends fork:true to a repository-search query', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      { maxQueries: 40, enableCodeSearch: true },
    );
    const repoSpecs = specs.filter((s) => s.kind === 'repositories');
    expect(repoSpecs.length).toBeGreaterThan(0);
    expect(repoSpecs.some((s) => s.query.includes('fork:true'))).toBe(false);
  });
});

describe('onlyKeyword scoping (per-keyword discovery toggle)', () => {
  it('emits only the brand-keyword-custom repo-search + code-search pair for that one keyword, skipping every other family', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha', 'otp bypass', 'kite login'],
          trustedGithubOwners: ['zerodha'],
        },
      ],
      {
        maxQueries: 40,
        enableCodeSearch: true,
        onlyKeyword: 'otp bypass',
        scopedToBrand: true,
      },
    );

    const families = new Set(specs.map((s) => s.family));
    expect(families).toEqual(
      new Set(['brand-keyword-custom', 'brand-keyword-custom-code']),
    );
    // The other custom keyword ("kite login") must not sneak in.
    expect(specs.every((s) => s.query.includes('otp bypass'))).toBe(true);
    expect(specs.some((s) => s.query.includes('kite login'))).toBe(false);

    const repoSpec = specs.find((s) => s.family === 'brand-keyword-custom');
    expect(repoSpec?.kind).toBe('repositories');
    // Searches the keyword ALONE - not AND-combined with "zerodha" - so a
    // repo mentioning "otp bypass" without also literally saying "zerodha"
    // anywhere in its name/description still gets found. Quoted because it's
    // a multi-word phrase (phraseify).
    expect(repoSpec?.query).toBe('"otp bypass"');

    const codeSpec = specs.find(
      (s) => s.family === 'brand-keyword-custom-code',
    );
    expect(codeSpec?.kind).toBe('code');
    expect(codeSpec?.query).toBe('"otp bypass" fork:true');
  });

  it("searches the toggled keyword alone, regardless of the brand's own identity term (brand.keywords[0]) - onlyKeyword's query no longer depends on it", () => {
    // Regression guard: naively narrowing brand.keywords to [onlyKeyword]
    // before calling buildQueryFamilies would previously have corrupted
    // `term` (derived from keywords[0]) for every family. That's moot for
    // the query itself now (it no longer references the brand's identity
    // term at all), but this still asserts a completely unrelated keyword
    // ("zerodha-primary" as keywords[0]) has zero influence on what gets
    // searched for.
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha-primary', 'phishing-bait-term'],
        },
      ],
      { enableCodeSearch: true, onlyKeyword: 'phishing-bait-term' },
    );

    const repoSpec = specs.find((s) => s.family === 'brand-keyword-custom');
    // Not quoted - phraseify only quotes multi-word phrases, and this
    // hyphenated keyword has no space.
    expect(repoSpec?.query).toBe('phishing-bait-term');
    expect(repoSpec?.query).not.toContain('zerodha-primary');
  });

  it('respects enableCodeSearch=false - no code-search variant when disabled', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme', 'fraud'] }],
      { enableCodeSearch: false, onlyKeyword: 'fraud', scopedToBrand: true },
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].family).toBe('brand-keyword-custom');
  });

  it('emits nothing for a brand with no usable identity term (no keywords, no name)', () => {
    const specs = buildQueryFamilies(
      [{ name: '', aliases: [], keywords: [] }],
      { onlyKeyword: 'anything', scopedToBrand: true },
    );
    expect(specs).toEqual([]);
  });

  it('searches for the brand identity term alone if the toggled keyword equals it, instead of emitting nothing', () => {
    // Regression guard: previously this produced zero query specs, which
    // made the scan complete instantly with no results and flip the
    // per-keyword toggle back to "off" with no explanation - see
    // onlyKeyword handling in buildQueryFamilies.
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['Acme'] }],
      { enableCodeSearch: true, onlyKeyword: 'Acme', scopedToBrand: true },
    );
    const families = new Set(specs.map((s) => s.family));
    expect(families).toEqual(
      new Set(['brand-keyword-custom', 'brand-keyword-custom-code']),
    );
    const repoSpec = specs.find((s) => s.family === 'brand-keyword-custom');
    expect(repoSpec?.query).toBe('Acme');
    const codeSpec = specs.find(
      (s) => s.family === 'brand-keyword-custom-code',
    );
    expect(codeSpec?.query).toBe('"Acme" fork:true');
  });

  it("searchScope: 'repositories' skips the code-search half of the pair entirely, even with code search enabled", () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha', 'otp bypass'],
        },
      ],
      {
        enableCodeSearch: true,
        onlyKeyword: 'otp bypass',
        scopedToBrand: true,
        searchScope: 'repositories',
      },
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      kind: 'repositories',
      family: 'brand-keyword-custom',
      query: '"otp bypass"',
    });
  });

  it("searchScope: 'code' skips the repo-search half of the pair entirely", () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Zerodha',
          aliases: ['zerodha'],
          keywords: ['zerodha', 'otp bypass'],
        },
      ],
      {
        enableCodeSearch: true,
        onlyKeyword: 'otp bypass',
        scopedToBrand: true,
        searchScope: 'code',
      },
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      kind: 'code',
      family: 'brand-keyword-custom-code',
      query: '"otp bypass" fork:true',
    });
  });

  it("searchScope: 'code' still emits nothing for the code half when code search is disabled entirely (enableCodeSearch takes precedence)", () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme', 'fraud'] }],
      {
        enableCodeSearch: false,
        onlyKeyword: 'fraud',
        scopedToBrand: true,
        searchScope: 'code',
      },
    );
    expect(specs).toEqual([]);
  });

  it("searchScope defaults to 'both' when omitted, matching the pre-existing behavior", () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme', 'fraud'] }],
      { enableCodeSearch: true, onlyKeyword: 'fraud', scopedToBrand: true },
    );
    const families = new Set(specs.map((s) => s.family));
    expect(families).toEqual(
      new Set(['brand-keyword-custom', 'brand-keyword-custom-code']),
    );
  });

  it('searchScope has no effect outside onlyKeyword mode - a full family sweep is unaffected', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      {
        enableCodeSearch: true,
        scopedToBrand: true,
        searchScope: 'repositories',
      },
    );
    expect(specs.some((s) => s.kind === 'code')).toBe(true);
  });
});

describe('query correctness for multi-word brand names and OR grouping', () => {
  it('quotes a multi-word brand identity term as one phrase in repository-search queries, matching how the keyword itself is already quoted', () => {
    // Regression: "Angel One" (unquoted) is read by GitHub as two
    // independent required words that can match anywhere, unrelated to
    // each other - not the brand name as a phrase. The matching code-search
    // query already quoted it; repo-search queries didn't.
    const specs = buildQueryFamilies(
      [{ name: 'Angel One', aliases: [], keywords: ['Angel One'] }],
      { enableCodeSearch: true, scopedToBrand: true },
    );
    const phishing = specs.find((s) => s.family === 'phishing');
    const apk = specs.find((s) => s.family === 'apk');
    const impersonation = specs.find((s) => s.family === 'impersonation');
    expect(phishing?.query.startsWith('"Angel One" ')).toBe(true);
    expect(apk?.query.startsWith('"Angel One" ')).toBe(true);
    expect(impersonation?.query.startsWith('"Angel One" ')).toBe(true);
  });

  it('leaves a single-word brand identity term unquoted (quoting is a no-op either way, but this asserts no unnecessary change)', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Zerodha', aliases: [], keywords: ['Zerodha'] }],
      { enableCodeSearch: true, scopedToBrand: true },
    );
    const phishing = specs.find((s) => s.family === 'phishing');
    expect(phishing?.query.startsWith('Zerodha (')).toBe(true);
  });

  it("parenthesizes the impersonation family's OR-group so the brand term is required, not optional", () => {
    // Regression: `${safe} clone OR spoof OR fake OR unofficial in:name,description`
    // (no parens) is read by GitHub as (safe AND clone) OR spoof OR fake OR
    // unofficial - matching ANY repo containing just the bare word "fake",
    // "spoof", or "unofficial" anywhere, with no brand connection at all.
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['Acme'] }],
      { scopedToBrand: true },
    );
    const impersonation = specs.find((s) => s.family === 'impersonation');
    expect(impersonation?.query).toBe(
      'Acme (clone OR spoof OR fake OR unofficial) in:name,description',
    );
  });

  it('quotes a multi-word brand term in the brand-secret code-search query too', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Angel One', aliases: [], keywords: ['Angel One'] }],
      { enableCodeSearch: true, scopedToBrand: true },
    );
    const brandSecret = specs.find((s) => s.family === 'brand-secret');
    expect(brandSecret?.query.startsWith('"Angel One" ')).toBe(true);
  });
});

describe('trusted-account family', () => {
  it('emits both org: and user: sweeps for each trusted owner', () => {
    const specs = buildQueryFamilies([
      {
        name: 'AngelOne',
        aliases: ['angelone'],
        keywords: ['angelone'],
        trustedGithubOwners: ['angel-one-tech'],
      },
    ]);
    const trusted = specs.filter((s) => s.family === 'trusted-account');
    expect(trusted.map((s) => s.query)).toEqual(
      expect.arrayContaining(['org:angel-one-tech', 'user:angel-one-tech']),
    );
    expect(trusted.every((s) => s.kind === 'repositories')).toBe(true);
  });

  it('emits nothing when no trusted owners are configured', () => {
    const specs = buildQueryFamilies([
      { name: 'Acme', aliases: ['acme'], keywords: ['acme'] },
    ]);
    expect(specs.some((s) => s.family === 'trusted-account')).toBe(false);
  });

  it('sanitizes owner input before building the qualifier', () => {
    const specs = buildQueryFamilies([
      {
        name: 'Acme',
        aliases: [],
        keywords: ['acme'],
        trustedGithubOwners: ['  acme "org" '],
      },
    ]);
    const trusted = specs.filter((s) => s.family === 'trusted-account');
    expect(trusted.map((s) => s.query)).toEqual(
      expect.arrayContaining(['org:acmeorg', 'user:acmeorg']),
    );
  });
});

describe('buildCreatedQualifier', () => {
  it('returns undefined when neither bound is given', () => {
    expect(buildCreatedQualifier()).toBeUndefined();
  });

  it('builds a range when both bounds are given', () => {
    expect(buildCreatedQualifier('2026-07-31', '2026-08-02')).toBe(
      'created:2026-07-31..2026-08-02',
    );
  });

  it('builds a one-sided qualifier when only one bound is given', () => {
    expect(buildCreatedQualifier('2026-07-31', undefined)).toBe(
      'created:>=2026-07-31',
    );
    expect(buildCreatedQualifier(undefined, '2026-08-02')).toBe(
      'created:<=2026-08-02',
    );
  });

  it('rejects createdFrom after createdTo', () => {
    expect(() => buildCreatedQualifier('2026-08-02', '2026-07-31')).toThrow(
      BadRequestException,
    );
  });

  it('rejects dates before GitHub existed', () => {
    expect(() => buildCreatedQualifier('2000-01-01', undefined)).toThrow(
      BadRequestException,
    );
  });

  it('rejects future dates', () => {
    expect(() => buildCreatedQualifier('2999-01-01', undefined)).toThrow(
      BadRequestException,
    );
  });

  it('rejects malformed dates', () => {
    expect(() => buildCreatedQualifier('not-a-date', undefined)).toThrow(
      BadRequestException,
    );
  });
});

describe('buildPushedQualifier', () => {
  it('returns undefined when neither bound is given', () => {
    expect(buildPushedQualifier()).toBeUndefined();
  });

  it('builds a range when both bounds are given', () => {
    expect(buildPushedQualifier('2026-07-31', '2026-08-02')).toBe(
      'pushed:2026-07-31..2026-08-02',
    );
  });

  it('builds a one-sided qualifier when only one bound is given', () => {
    expect(buildPushedQualifier('2026-07-31', undefined)).toBe(
      'pushed:>=2026-07-31',
    );
    expect(buildPushedQualifier(undefined, '2026-08-02')).toBe(
      'pushed:<=2026-08-02',
    );
  });

  it('rejects pushedFrom after pushedTo', () => {
    expect(() => buildPushedQualifier('2026-08-02', '2026-07-31')).toThrow(
      BadRequestException,
    );
  });

  it('rejects future dates', () => {
    expect(() => buildPushedQualifier('2999-01-01', undefined)).toThrow(
      BadRequestException,
    );
  });
});

describe('buildQueryFamilies date range integration', () => {
  it('appends the created qualifier only to repository-kind queries', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      {
        maxQueries: 40,
        enableCodeSearch: true,
        createdFrom: '2026-07-31',
        createdTo: '2026-08-02',
      },
    );
    const repoSpecs = specs.filter((s) => s.kind === 'repositories');
    const codeSpecs = specs.filter((s) => s.kind === 'code');
    expect(repoSpecs.length).toBeGreaterThan(0);
    expect(
      repoSpecs.every((s) =>
        s.query.includes('created:2026-07-31..2026-08-02'),
      ),
    ).toBe(true);
    expect(codeSpecs.every((s) => !s.query.includes('created:'))).toBe(true);
  });

  it('an explicit date range overrides GITHUB_SEARCH_DATE', () => {
    process.env.GITHUB_SEARCH_DATE = 'created:2020-01-01..2020-12-31';
    try {
      const specs = buildQueryFamilies(
        [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
        { maxQueries: 40, createdFrom: '2026-07-31' },
      );
      const repoSpec = specs.find((s) => s.kind === 'repositories');
      expect(repoSpec?.query).toContain('created:>=2026-07-31');
      expect(repoSpec?.query).not.toContain('2020');
    } finally {
      delete process.env.GITHUB_SEARCH_DATE;
    }
  });

  it('appends the pushed qualifier only to repository-kind queries, independent of created', () => {
    // Regression: "Only today's repos" only ever filtered by repo CREATION
    // date - a repo created years ago that was just pushed to today (a new
    // secret, a new brand mention) never matched it. pushedFrom/pushedTo
    // filters by last-activity date instead, and is orthogonal to
    // createdFrom/createdTo - neither implies or overrides the other.
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      {
        maxQueries: 40,
        enableCodeSearch: true,
        pushedFrom: '2026-08-10',
        pushedTo: '2026-08-10',
      },
    );
    const repoSpecs = specs.filter((s) => s.kind === 'repositories');
    const codeSpecs = specs.filter((s) => s.kind === 'code');
    expect(repoSpecs.length).toBeGreaterThan(0);
    expect(
      repoSpecs.every((s) => s.query.includes('pushed:2026-08-10..2026-08-10')),
    ).toBe(true);
    // GitHub code search supports neither qualifier - same restriction as
    // created:, for the same platform reason.
    expect(codeSpecs.every((s) => !s.query.includes('pushed:'))).toBe(true);
  });

  it('combines created and pushed qualifiers in the same repository query when both are set', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      {
        maxQueries: 40,
        createdFrom: '2024-01-01',
        createdTo: '2026-08-10',
        pushedFrom: '2026-08-01',
        pushedTo: '2026-08-10',
      },
    );
    const repoSpec = specs.find((s) => s.kind === 'repositories');
    expect(repoSpec?.query).toContain('created:2024-01-01..2026-08-10');
    expect(repoSpec?.query).toContain('pushed:2026-08-01..2026-08-10');
  });

  it("dateFilterMode: 'or' issues two queries per family - one created-only, one pushed-only - instead of one AND'd query", () => {
    // Regression: "repos created today OR changed today" was previously
    // unrepresentable - GitHub has no OR between two different qualifier
    // types in one query string, and the old behavior always AND'd both
    // together, which is a much NARROWER (and wrong) result for this ask.
    const specs = buildQueryFamilies(
      [{ name: 'AngelOne', aliases: ['angelone'], keywords: ['angelone'] }],
      {
        maxQueries: 40,
        enableCodeSearch: true,
        createdFrom: '2026-08-10',
        createdTo: '2026-08-10',
        pushedFrom: '2026-08-10',
        pushedTo: '2026-08-10',
        dateFilterMode: 'or',
      },
    );
    const phishingSpecs = specs.filter((s) => s.family === 'phishing');
    // One 'phishing' family query per brand normally - now two, one per
    // qualifier variant, both still carrying the brand/keyword content.
    expect(phishingSpecs).toHaveLength(2);
    expect(
      phishingSpecs.some((s) =>
        s.query.includes('created:2026-08-10..2026-08-10'),
      ),
    ).toBe(true);
    expect(
      phishingSpecs.some((s) =>
        s.query.includes('pushed:2026-08-10..2026-08-10'),
      ),
    ).toBe(true);
    // Neither variant should carry BOTH qualifiers - that would be AND, not OR.
    expect(
      phishingSpecs.every(
        (s) => !(s.query.includes('created:') && s.query.includes('pushed:')),
      ),
    ).toBe(true);
    // Code search is entirely unaffected - no OR-splitting since it never
    // gets a date qualifier at all.
    const codeSpecs = specs.filter((s) => s.kind === 'code');
    expect(
      codeSpecs.every(
        (s) => !s.query.includes('created:') && !s.query.includes('pushed:'),
      ),
    ).toBe(true);
  });

  it("dateFilterMode: 'or' with only one of created/pushed set behaves the same as 'and' (nothing to OR against)", () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      {
        maxQueries: 40,
        createdFrom: '2026-08-10',
        createdTo: '2026-08-10',
        dateFilterMode: 'or',
      },
    );
    const phishingSpecs = specs.filter((s) => s.family === 'phishing');
    expect(phishingSpecs).toHaveLength(1);
    expect(phishingSpecs[0].query).toContain('created:2026-08-10..2026-08-10');
  });
});

describe('buildDateQualifierVariants', () => {
  it('returns an empty array when neither qualifier applies', () => {
    expect(
      buildDateQualifierVariants(undefined, undefined, undefined, undefined),
    ).toEqual([]);
  });

  it("combines both into one AND'd string by default ('and' mode)", () => {
    expect(
      buildDateQualifierVariants(
        '2026-01-01',
        '2026-08-10',
        '2026-08-01',
        '2026-08-10',
      ),
    ).toEqual(['created:2026-01-01..2026-08-10 pushed:2026-08-01..2026-08-10']);
  });

  it("returns two independent qualifiers in 'or' mode when both are present", () => {
    expect(
      buildDateQualifierVariants(
        '2026-08-10',
        '2026-08-10',
        '2026-08-10',
        '2026-08-10',
        'or',
      ),
    ).toEqual([
      'created:2026-08-10..2026-08-10',
      'pushed:2026-08-10..2026-08-10',
    ]);
  });

  it("falls back to a single combined qualifier in 'or' mode when only one side is set", () => {
    expect(
      buildDateQualifierVariants(
        '2026-08-10',
        '2026-08-10',
        undefined,
        undefined,
        'or',
      ),
    ).toEqual(['created:2026-08-10..2026-08-10']);
  });
});

describe('distinctive-content family', () => {
  it('emits one quoted exact-phrase code-search query per distinctive phrase', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Acme',
          aliases: [],
          keywords: ['acme'],
          distinctivePhrases: [
            'Track your shipment in real time with Acme Express',
            'Nationwide logistics for e-commerce sellers',
          ],
        },
      ],
      { maxQueries: 40, enableCodeSearch: true },
    );
    const contentSpecs = specs.filter(
      (s) => s.family === 'distinctive-content',
    );
    expect(contentSpecs).toHaveLength(2);
    expect(contentSpecs.every((s) => s.kind === 'code')).toBe(true);
    expect(
      contentSpecs.some(
        (s) =>
          s.query ===
          '"Track your shipment in real time with Acme Express" fork:true',
      ),
    ).toBe(true);
  });

  it('is omitted entirely when code search is disabled', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Acme',
          aliases: [],
          keywords: ['acme'],
          distinctivePhrases: [
            'Track your shipment in real time with Acme Express',
          ],
        },
      ],
      { maxQueries: 40, enableCodeSearch: false },
    );
    expect(specs.some((s) => s.family === 'distinctive-content')).toBe(false);
  });

  it('caps distinctive-content queries at 5 per brand', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Acme',
          aliases: [],
          keywords: ['acme'],
          distinctivePhrases: Array.from(
            { length: 10 },
            (_, i) =>
              `Distinctive phrase number ${i} about Acme Express nationwide`,
          ),
        },
      ],
      { maxQueries: 100, enableCodeSearch: true },
    );
    expect(
      specs.filter((s) => s.family === 'distinctive-content'),
    ).toHaveLength(5);
  });

  it('strips stray double quotes from a phrase before quoting the query', () => {
    const specs = buildQueryFamilies(
      [
        {
          name: 'Acme',
          aliases: [],
          keywords: ['acme'],
          distinctivePhrases: ['Say "hello" to Acme Express nationwide'],
        },
      ],
      { maxQueries: 40, enableCodeSearch: true },
    );
    const spec = specs.find((s) => s.family === 'distinctive-content');
    expect(spec?.query).toBe(
      '"Say hello to Acme Express nationwide" fork:true',
    );
  });

  it('does nothing when no distinctive phrases are provided', () => {
    const specs = buildQueryFamilies(
      [{ name: 'Acme', aliases: [], keywords: ['acme'] }],
      { maxQueries: 40, enableCodeSearch: true },
    );
    expect(specs.some((s) => s.family === 'distinctive-content')).toBe(false);
  });
});

describe('groupTopPhrasesByBrand', () => {
  it('keeps only the top N rows per brand, preserving input order', () => {
    const brandA = 'brand-a';
    const brandB = 'brand-b';
    const rows = [
      { brandId: brandA, text: 'a1' },
      { brandId: brandB, text: 'b1' },
      { brandId: brandA, text: 'a2' },
      { brandId: brandA, text: 'a3' },
      { brandId: brandB, text: 'b2' },
    ];
    const grouped = groupTopPhrasesByBrand(rows, 2);
    expect(grouped.get(brandA)).toEqual(['a1', 'a2']);
    expect(grouped.get(brandB)).toEqual(['b1', 'b2']);
  });

  it('stringifies non-string brandId keys (e.g. ObjectId) consistently', () => {
    const id = { toString: () => 'brand-object-id' };
    const rows = [{ brandId: id, text: 'phrase' }];
    const grouped = groupTopPhrasesByBrand(rows, 5);
    expect(grouped.get('brand-object-id')).toEqual(['phrase']);
  });

  it('returns an empty map for no rows', () => {
    expect(groupTopPhrasesByBrand([], 5).size).toBe(0);
  });

  it('never exceeds the limit even with many rows for one brand', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      brandId: 'brand-a',
      text: `phrase-${i}`,
    }));
    const grouped = groupTopPhrasesByBrand(rows, 3);
    expect(grouped.get('brand-a')).toHaveLength(3);
  });
});

describe('buildLanguageSplitQueries', () => {
  it('appends one language qualifier per split, one query per configured language, PLUS one trailing catch-all query', () => {
    const queries = buildLanguageSplitQueries('filename:.env AKIA');
    expect(queries).toHaveLength(CODE_SEARCH_SPLIT_LANGUAGES.length + 1);
    expect(queries.slice(0, CODE_SEARCH_SPLIT_LANGUAGES.length)).toEqual(
      CODE_SEARCH_SPLIT_LANGUAGES.map(
        (lang) => `filename:.env AKIA language:${lang}`,
      ),
    );
  });

  it('the trailing catch-all query negates every configured language, catching files GitHub never classified (e.g. dotfiles like .env itself)', () => {
    const queries = buildLanguageSplitQueries('filename:.env AKIA');
    const catchAll = queries[queries.length - 1];
    expect(catchAll.startsWith('filename:.env AKIA ')).toBe(true);
    for (const lang of CODE_SEARCH_SPLIT_LANGUAGES) {
      expect(catchAll).toContain(`-language:${lang}`);
    }
  });

  it('produces every distinct query string (each gets its own DiscoveryCursor)', () => {
    const queries = buildLanguageSplitQueries('extension:pem BEGIN PRIVATE');
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe('splitCreatedRangeQuery', () => {
  it('bisects a bounded created:X..Y range into two non-overlapping halves', () => {
    const halves = splitCreatedRangeQuery(
      'zerodha (login OR otp) in:name,description created:2026-08-07..2026-08-08',
    );
    expect(halves).not.toBeNull();
    const [first, second] = halves!;
    expect(first).toMatch(
      /created:2026-08-07\.\.2026-08-07T\d{2}:\d{2}:\d{2}Z/,
    );
    expect(second).toMatch(
      /created:2026-08-07T\d{2}:\d{2}:\d{2}Z\.\.2026-08-08/,
    );
    // Only the created: clause changes - the rest of the query is untouched.
    expect(first).toContain('zerodha (login OR otp) in:name,description');
    expect(second).toContain('zerodha (login OR otp) in:name,description');
  });

  it('produces two halves whose boundary does not overlap (end of first is before start of second)', () => {
    const [first, second] = splitCreatedRangeQuery(
      'filename:id_rsa created:2026-08-01..2026-08-03',
    )!;
    const firstEnd = new Date(first.match(/\.\.(\S+)/)![1]);
    const secondStart = new Date(second.match(/created:(\S+)\.\./)![1]);
    expect(firstEnd.getTime()).toBeLessThan(secondStart.getTime());
  });

  it('together, the two halves span the entire original range with no gap', () => {
    const original = 'filename:id_rsa created:2026-08-01..2026-08-03';
    const [, origTo] = original.match(/created:(\S+)\.\.(\S+)/)!.slice(1);
    const [first, second] = splitCreatedRangeQuery(original)!;
    const [firstFrom] = first.match(/created:(\S+)\.\./)!.slice(1);
    const [secondTo] = second.match(/\.\.(\S+)$/)!.slice(1);
    expect(firstFrom).toBe('2026-08-01');
    expect(secondTo).toBe(origTo);
  });

  it('returns null when the query has no created: qualifier at all', () => {
    expect(
      splitCreatedRangeQuery('zerodha (login OR otp) in:name,description'),
    ).toBeNull();
  });

  it('returns null for an unbounded range (created:>=X has no ".." to split on)', () => {
    expect(
      splitCreatedRangeQuery('filename:id_rsa created:>=2026-08-01'),
    ).toBeNull();
  });

  it('splits a same-day range (regression: "Only today\'s repos" produces created:X..X, which must NOT measure as zero-width)', () => {
    const halves = splitCreatedRangeQuery(
      'zerodha (login OR otp) in:name,description created:2026-08-07..2026-08-07',
    );
    expect(halves).not.toBeNull();
    const [first, second] = halves!;
    expect(first).toContain('created:2026-08-07..2026-08-07T1');
    expect(second).toContain('created:2026-08-07T1');
    expect(second).toContain('..2026-08-07');
  });

  it('returns null once the range is already too narrow to usefully split further', () => {
    expect(
      splitCreatedRangeQuery(
        'filename:id_rsa created:2026-08-01T10:00:00Z..2026-08-01T10:00:30Z',
      ),
    ).toBeNull();
  });

  it('can be applied recursively - splitting a half again yields an even narrower valid split', () => {
    const [first] = splitCreatedRangeQuery(
      'filename:id_rsa created:2026-08-01..2026-08-08',
    )!;
    const again = splitCreatedRangeQuery(first);
    expect(again).not.toBeNull();
    const [quarterA, quarterB] = again!;
    expect(quarterA).toContain('filename:id_rsa');
    expect(quarterB).toContain('filename:id_rsa');
  });
});

describe('ensureBoundedCreatedRange', () => {
  it('leaves an already-bounded created:X..Y range unchanged', () => {
    const query = 'zerodha in:name created:2026-01-01..2026-02-01';
    expect(ensureBoundedCreatedRange(query)).toBe(query);
  });

  it('bounds an unbounded lower range (created:>=X) up to a fixed far-future ceiling, not today', () => {
    const result = ensureBoundedCreatedRange(
      'filename:id_rsa created:>=2026-08-01',
    );
    expect(result).toBe('filename:id_rsa created:2026-08-01..2099-12-31');
    expect(result).not.toContain('>=');
  });

  it("bounds an unbounded upper range (created:<=Y) down to GitHub's founding date", () => {
    const result = ensureBoundedCreatedRange(
      'filename:id_rsa created:<=2026-08-01',
    );
    expect(result).toBe('filename:id_rsa created:2008-01-01..2026-08-01');
  });

  it('appends a full range when there is no created: qualifier at all', () => {
    const result = ensureBoundedCreatedRange(
      'zerodha (login OR otp) in:name,description',
    );
    expect(result).toBe(
      'zerodha (login OR otp) in:name,description created:2008-01-01..2099-12-31',
    );
  });

  it('the normalized output is always splittable by splitCreatedRangeQuery', () => {
    const result = ensureBoundedCreatedRange(
      'zerodha (login OR otp) in:name,description',
    );
    expect(splitCreatedRangeQuery(result)).not.toBeNull();
  });

  it('produces the exact same normalized query no matter what day it is (regression: previously anchored to "today", which drifted the split midpoint ~12h per calendar day and orphaned in-progress DiscoveryCursor rows keyed on the old query text)', () => {
    const query = 'zerodha (login OR otp) in:name,description';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00Z'));
    const day1 = ensureBoundedCreatedRange(query);
    jest.setSystemTime(new Date('2026-08-17T09:30:00Z'));
    const day2 = ensureBoundedCreatedRange(query);
    jest.useRealTimers();
    expect(day1).toBe(day2);
  });
});

describe('splitSizeRangeQuery', () => {
  it('bisects a bounded size:X..Y range into two non-overlapping halves', () => {
    const halves = splitSizeRangeQuery('filename:.env AKIA size:0..1000');
    expect(halves).not.toBeNull();
    const [first, second] = halves!;
    expect(first).toBe('filename:.env AKIA size:0..500');
    expect(second).toBe('filename:.env AKIA size:501..1000');
    // Only the size: clause changes.
    expect(first).toContain('filename:.env AKIA');
    expect(second).toContain('filename:.env AKIA');
  });

  it('together, the two halves span the entire original range with no gap and no overlap', () => {
    const [first, second] = splitSizeRangeQuery(
      'extension:pem BEGIN PRIVATE size:100..900',
    )!;
    const firstEnd = Number(first.match(/\.\.(\d+)/)![1]);
    const secondStart = Number(second.match(/size:(\d+)\.\./)![1]);
    expect(secondStart).toBe(firstEnd + 1);
    expect(first).toContain('size:100..');
    expect(second).toContain('..900');
  });

  it('returns null when the query has no size: qualifier at all', () => {
    expect(splitSizeRangeQuery('filename:.env AKIA')).toBeNull();
  });

  it('returns null for an unbounded range (size:>N has no ".." to split on)', () => {
    expect(splitSizeRangeQuery('filename:.env AKIA size:>1000')).toBeNull();
  });

  it('returns null once the range is already too narrow to usefully split further', () => {
    expect(splitSizeRangeQuery('filename:.env AKIA size:100..105')).toBeNull();
  });

  it('can be applied recursively - splitting a half again yields an even narrower valid split', () => {
    const [first] = splitSizeRangeQuery('filename:.env AKIA size:0..100000')!;
    const again = splitSizeRangeQuery(first);
    expect(again).not.toBeNull();
    const [quarterA, quarterB] = again!;
    expect(quarterA).toContain('filename:.env AKIA');
    expect(quarterB).toContain('filename:.env AKIA');
  });
});

describe('ensureBoundedSizeRange', () => {
  it('leaves an already-bounded size:X..Y range unchanged', () => {
    const query = 'filename:.env AKIA size:0..5000';
    expect(ensureBoundedSizeRange(query)).toBe(query);
  });

  it('bounds an unbounded lower range (size:>=N) up to the max byte ceiling', () => {
    const result = ensureBoundedSizeRange('filename:.env AKIA size:>=1000');
    expect(result).toBe('filename:.env AKIA size:1000..100000000');
  });

  it('bounds an unbounded upper range (size:<N) down to zero', () => {
    const result = ensureBoundedSizeRange('filename:.env AKIA size:<5000');
    expect(result).toBe('filename:.env AKIA size:0..5000');
  });

  it('appends a full range when there is no size: qualifier at all', () => {
    const result = ensureBoundedSizeRange('filename:.env AKIA');
    expect(result).toBe('filename:.env AKIA size:0..100000000');
  });

  it('the normalized output is always splittable by splitSizeRangeQuery', () => {
    const result = ensureBoundedSizeRange('filename:.env AKIA');
    expect(splitSizeRangeQuery(result)).not.toBeNull();
  });
});

describe('typo-squat variants', () => {
  it('generates attack-intent names without the bare brand', () => {
    const variants = generateTypoVariants('PhonePe', 8);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants).not.toContain('phonepe');
    expect(variants.some((v) => v.includes('login') || v.includes('apk'))).toBe(
      true,
    );
  });
});
