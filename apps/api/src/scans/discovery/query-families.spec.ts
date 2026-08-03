import { BadRequestException } from '@nestjs/common';
import { buildCreatedQualifier, buildQueryFamilies } from './query-families';
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
          { keyword: 'low-priority', category: 'phishing', priority: 2 },
          { keyword: 'high-priority', category: 'phishing', priority: 9 },
          { keyword: 'mid-priority', category: 'phishing', priority: 5 },
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
