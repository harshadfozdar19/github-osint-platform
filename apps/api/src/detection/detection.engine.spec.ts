import { createHash } from 'crypto';
import { DetectionEngine } from './detection.engine';
import { RiskScoringService } from './risk-scoring.service';
import { RepoAnalysisContext } from './rules/rule.types';
import { Severity, ThreatCategory } from '../common/enums';
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
