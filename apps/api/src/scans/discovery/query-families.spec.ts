import { buildQueryFamilies } from './query-families';
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
