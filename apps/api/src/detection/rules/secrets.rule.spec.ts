import { createHash } from 'crypto';
import {
  findCredentialReuseMatches,
  findFullRepoSecretMatches,
  secretDetectionRule,
} from './secrets.rule';
import { RepoAnalysisContext } from './rule.types';
import { DetectionResult, ThreatCategory } from '../../common/enums';

function hashOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// secretDetectionRule.evaluate() is typed via the shared DetectionRule
// interface (DetectionResult | DetectionResult[] | null); this rule's own
// implementation always returns an array, so normalize the same way
// detection.engine.ts does before asserting on it.
function evaluate(ctx: RepoAnalysisContext): DetectionResult[] {
  const output = secretDetectionRule.evaluate(ctx);
  if (!output) return [];
  return Array.isArray(output) ? output : [output];
}

const baseCtx = (content: string, path = '.env'): RepoAnalysisContext => ({
  fullName: 'evil/leaked-config',
  owner: 'evil',
  name: 'leaked-config',
  description: '',
  topics: [],
  language: 'JavaScript',
  stars: 0,
  forks: 0,
  isFork: false,
  githubCreatedAt: new Date(),
  filePaths: [path],
  readmeText: '',
  smallFileTexts: [{ path, content }],
});

describe('secretDetectionRule', () => {
  it('detects MongoDB and Redis connection strings', () => {
    const results = evaluate(
      baseCtx(
        'MONGO=mongodb+srv://user:pass@cluster.example.net/db\nREDIS=rediss://:secret@redis.example.com:6380/0',
      ),
    );
    const ids = results.map((r) => r.ruleId);
    expect(ids).toContain('secret-mongodb-uri');
    expect(ids).toContain('secret-redis-uri');
    expect(
      results.every((r) => r.category === ThreatCategory.EXPOSED_SECRET),
    ).toBe(true);
  });

  it('detects OpenAI and Gemini API keys', () => {
    const results = evaluate(
      baseCtx(
        // Split so no single literal substring matches a real secret pattern
        // (avoids tripping secret scanners); value is unchanged.
        'OPENAI=' +
          'sk-proj-abcdefghijklmnopqrstuvwxyz123456' +
          '\nGEMINI=' +
          'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg',
      ),
    );
    const ids = results.map((r) => r.ruleId);
    expect(ids).toContain('secret-openai-key');
    expect(ids).toContain('secret-gemini-key');
  });

  it('detects Firebase service account JSON and Slack/Discord bot tokens', () => {
    const results = evaluate(
      baseCtx(
        [
          '{"type":"service_account","project_id":"demo","private_key":"-----BEGIN PRIVATE KEY-----',
          // Split into concatenated parts so no single literal substring in
          // this file matches a real-token pattern (avoids tripping secret
          // scanners on push) while the resulting fixture value is unchanged.
          'SLACK=' +
            'xoxb-1234567890-1234567890123-' +
            'abcdefghijklmnopqrstuvwx',
          'DISCORD=' +
            'MTAxMjM0NTY3ODkwMTIzNDU2Nw' +
            '.GaBcDe.' +
            'fGhIjKlMnOpQrStUvWxYz1234567890AbCdEf',
        ].join('\n'),
        'firebase-service.json',
      ),
    );
    const ids = results.map((r) => r.ruleId);
    expect(ids).toContain('secret-firebase-service-account');
    expect(ids).toContain('secret-slack-token');
    expect(ids).toContain('secret-discord-bot');
  });

  it('detects JWT assignments and boosts severity in secret paths', () => {
    const results = evaluate(
      baseCtx(
        'access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        'config/.env.production',
      ),
    );
    const jwtAssignment = results.find(
      (r) => r.ruleId === 'secret-api-jwt-bearer',
    );
    expect(jwtAssignment).toBeDefined();
    expect(jwtAssignment?.evidence).toContain('[REDACTED]');
    expect(jwtAssignment?.explanation).toContain('secrets file');
  });

  it('links a README-found secret to the README\'s real path, not the literal "readme"', () => {
    const ctx: RepoAnalysisContext = {
      ...baseCtx('', 'unused.txt'),
      smallFileTexts: [],
      readmeText: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      readmePath: 'docs/Readme.rst',
    };
    const results = evaluate(ctx);
    const hit = results.find((r) => r.ruleId === 'secret-aws-access-key');
    expect(hit?.file).toBe('docs/Readme.rst');
  });

  it('falls back to README.md for a README-found secret when the real path is unknown', () => {
    const ctx: RepoAnalysisContext = {
      ...baseCtx('', 'unused.txt'),
      smallFileTexts: [],
      readmeText: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
    };
    const results = evaluate(ctx);
    const hit = results.find((r) => r.ruleId === 'secret-aws-access-key');
    expect(hit?.file).toBe('README.md');
  });

  it('reports every occurrence of the same secret pattern across different files, not just the first', () => {
    const ctx: RepoAnalysisContext = {
      ...baseCtx('', 'unused.txt'),
      smallFileTexts: [
        { path: '.env', content: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE' },
        {
          path: 'config/.env.staging',
          content: 'AWS_KEY=AKIAABCDEFGHIJKLMNOP',
        },
        { path: 'deploy/.env.prod', content: 'AWS_KEY=AKIAQRSTUVWXYZ123456' },
      ],
    };
    const results = evaluate(ctx);
    const hits = results.filter((r) => r.ruleId === 'secret-aws-access-key');
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.file).sort()).toEqual(
      ['.env', 'config/.env.staging', 'deploy/.env.prod'].sort(),
    );
  });

  it('caps matches per pattern instead of reporting an unbounded number', () => {
    const content = Array.from(
      { length: 15 },
      (_, i) => `AWS_KEY_${i}=AKIAIOSFODNN7EXAMPLE`,
    ).join('\n');
    const ctx: RepoAnalysisContext = {
      ...baseCtx('', 'unused.txt'),
      smallFileTexts: [{ path: '.env', content }],
    };
    const results = evaluate(ctx);
    const hits = results.filter((r) => r.ruleId === 'secret-aws-access-key');
    expect(hits).toHaveLength(10);
  });

  it('omits the file link for a secret found only in the repo description', () => {
    const ctx: RepoAnalysisContext = {
      ...baseCtx('', 'unused.txt'),
      smallFileTexts: [],
      description: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
    };
    const results = evaluate(ctx);
    const hit = results.find((r) => r.ruleId === 'secret-aws-access-key');
    expect(hit?.file).toBeUndefined();
  });

  it('does not flag a config value that is actually a code reference, not a literal key (regression: api_key=settings.openai_api_key)', () => {
    const results = evaluate(
      baseCtx('api_key=settings.openai_api_key', 'app/config.py'),
    );
    expect(results.some((r) => r.ruleId === 'secret-generic-api-token')).toBe(
      false,
    );
  });

  it('does not flag a variable assigned from a function call, not a literal (regression: accessToken=generateAccessToken(user))', () => {
    const results = evaluate(
      baseCtx(
        'const accessToken = generateAccessToken(user);',
        'controllers/auth.controller.js',
      ),
    );
    expect(results.some((r) => r.ruleId === 'secret-generic-api-token')).toBe(
      false,
    );
  });

  it('does not flag a TS camelCase property reference as a leaked secret (regression: R2 client false positive)', () => {
    // Real report: `secretAccessKey: config.secretAccessKey!` and
    // `continuationToken = resp.nextContinuationToken` were both flagged as
    // "High-Entropy Secret Assignment" - both are just code passing a
    // credential through from another object, not a hardcoded literal.
    const r1 = evaluate(
      baseCtx(
        'secretAccessKey: config.secretAccessKey!,',
        'src/lib/r2/client.ts',
      ),
    );
    expect(r1.some((r) => r.ruleId === 'secret-high-entropy-assignment')).toBe(
      false,
    );

    const r2 = evaluate(
      baseCtx(
        'continuationToken = resp.nextContinuationToken;',
        'src/lib/r2/objects.ts',
      ),
    );
    expect(r2.some((r) => r.ruleId === 'secret-high-entropy-assignment')).toBe(
      false,
    );
  });

  it('still flags a real-looking generic API key assignment', () => {
    const results = evaluate(
      baseCtx('api_key=' + 'zK9mQ2xP7vL4nR8wY3tZ1aB6cD5eF', 'app/config.py'),
    );
    expect(results.some((r) => r.ruleId === 'secret-generic-api-token')).toBe(
      true,
    );
  });

  it('does not flag an example/placeholder api_key or access_token value (regression)', () => {
    const apiKey = evaluate(
      baseCtx("api_key: 'your_api_key_placeholder_value'", 'README.md'),
    );
    expect(apiKey.some((r) => r.ruleId === 'secret-generic-api-token')).toBe(
      false,
    );

    const accessToken = evaluate(
      baseCtx("access_token: 'sampleAccessToken'", 'README.md'),
    );
    expect(
      accessToken.some((r) => r.ruleId === 'secret-generic-api-token'),
    ).toBe(false);
  });

  it('does not flag an example "Bearer <placeholder>" header (regression)', () => {
    const results = evaluate(
      baseCtx('Authorization: Bearer sampleAccessToken', 'README.md'),
    );
    expect(results.some((r) => r.ruleId === 'secret-bearer-token')).toBe(false);
  });

  it('still flags a real-looking Bearer token', () => {
    const results = evaluate(
      baseCtx(
        'Authorization: Bearer zK9mQ2xP7vL4nR8wY3tZ1aB6cD5eF',
        'README.md',
      ),
    );
    expect(results.some((r) => r.ruleId === 'secret-bearer-token')).toBe(true);
  });

  it('does not flag a Docker/k8s-style "${VAR:-dev-default-change-in-production}" fallback as a leaked secret (regression)', () => {
    const results = evaluate(
      baseCtx(
        'JWT_SECRET: ${JWT_SECRET:-dev-secret-key-change-in-production}',
        'docker-compose.yml',
      ),
    );
    expect(
      results.some((r) => r.ruleId === 'secret-high-entropy-assignment'),
    ).toBe(false);
  });
});

describe('findCredentialReuseMatches', () => {
  const rawKey = 'AKIAIOSFODNN7EXAMPLE';

  it('returns [] immediately when there are no known hashes to check against', () => {
    const ctx = baseCtx(`AWS_KEY=${rawKey}`);
    expect(findCredentialReuseMatches(ctx, new Set())).toEqual([]);
  });

  it('returns [] when the repo has secrets but none match a known hash', () => {
    const ctx = baseCtx(`AWS_KEY=${rawKey}`);
    const unrelatedHash = hashOf('AKIADIFFERENTVALUEHERE1');
    expect(findCredentialReuseMatches(ctx, new Set([unrelatedHash]))).toEqual(
      [],
    );
  });

  it('flags an exact match against a known credential hash, with redacted evidence', () => {
    const ctx = baseCtx(`AWS_ACCESS_KEY_ID=${rawKey}`);
    const known = new Set([hashOf(rawKey)]);
    const matches = findCredentialReuseMatches(ctx, known);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      patternId: 'secret-aws-access-key',
      file: '.env',
      lineNumber: 1,
    });
    expect(matches[0].evidence).not.toContain(rawKey);
    expect(matches[0].evidence).toContain('[REDACTED]');
  });

  it('does not treat a different value of the same secret type as a match', () => {
    const ctx = baseCtx(`AWS_ACCESS_KEY_ID=${rawKey}`);
    const known = new Set([hashOf('AKIANOTTHESAMEVALUE999')]);
    expect(findCredentialReuseMatches(ctx, known)).toEqual([]);
  });

  it('matches regardless of which haystack (file vs README vs description) the value appears in', () => {
    const known = new Set([hashOf(rawKey)]);
    const ctx: RepoAnalysisContext = {
      ...baseCtx('', 'unused.txt'),
      smallFileTexts: [],
      readmeText: `Setup:\nAWS_ACCESS_KEY_ID=${rawKey}`,
      readmePath: 'docs/SETUP.md',
    };
    const matches = findCredentialReuseMatches(ctx, known);
    expect(matches).toHaveLength(1);
    expect(matches[0].file).toBe('docs/SETUP.md');
    expect(matches[0].lineNumber).toBe(2);
  });
});

describe('findFullRepoSecretMatches', () => {
  it('confirms a real match via regex re-verification, not just the anchor hit', () => {
    const results = findFullRepoSecretMatches(
      [
        {
          path: 'backend/config.py',
          lineNumber: 12,
          line: 'AWS_KEY = "AKIAIOSFODNN7EXAMPLE"',
        },
      ],
      new Set(),
      new Map(),
    );
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('secret-aws-access-key');
    expect(results[0].file).toBe('backend/config.py');
    expect(results[0].lineNumber).toBe(12);
    expect(results[0].evidence).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('does not report a bare anchor mention that never satisfies the real regex', () => {
    // "AKIA" appears, but not followed by 16 valid key characters.
    const results = findFullRepoSecretMatches(
      [{ path: 'README.md', lineNumber: 3, line: 'AKIA prefix explained' }],
      new Set(),
      new Map(),
    );
    expect(results).toEqual([]);
  });

  it('skips a match already reported by the sample-based pass, instead of double-counting it', () => {
    const results = findFullRepoSecretMatches(
      [
        {
          path: '.env',
          lineNumber: 1,
          line: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
        },
      ],
      new Set(['.env:1:secret-aws-access-key']),
      new Map(),
    );
    expect(results).toEqual([]);
  });

  it('respects MAX_MATCHES_PER_PATTERN as one combined budget across both passes', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      path: `file${i}.env`,
      lineNumber: 1,
      line: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
    }));
    // Sample pass already used 9 of the 10 allowed slots for this pattern.
    const results = findFullRepoSecretMatches(
      candidates,
      new Set(),
      new Map([['secret-aws-access-key', 9]]),
    );
    expect(results).toHaveLength(1);
  });

  it('reports a private-key PEM header on its own, without needing the closing END marker', () => {
    const results = findFullRepoSecretMatches(
      [
        {
          path: 'deploy/id_rsa',
          lineNumber: 1,
          line: '-----BEGIN RSA PRIVATE KEY-----',
        },
      ],
      new Set(),
      new Map(),
    );
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('secret-ssh-private-key');
    expect(results[0].file).toBe('deploy/id_rsa');
  });

  it('never flags a multi-line-only pattern (e.g. PEM certificate) from a single grepped line', () => {
    const results = findFullRepoSecretMatches(
      [
        {
          path: 'certs/ca.pem',
          lineNumber: 1,
          line: '-----BEGIN CERTIFICATE-----',
        },
      ],
      new Set(),
      new Map(),
    );
    expect(results).toEqual([]);
  });
});

describe('secretDetectionRule with full-repo candidates', () => {
  it('finds a secret outside the sampled files via ctx.fullRepoSecretCandidates', () => {
    const ctx: RepoAnalysisContext = {
      ...baseCtx('', 'unused.txt'),
      smallFileTexts: [],
      fullRepoSecretCandidates: [
        {
          path: 'deeply/nested/module/config.py',
          lineNumber: 88,
          line: 'STRIPE_KEY = "sk_live_abcdefghijklmnopqrst"',
        },
      ],
    };
    const results = evaluate(ctx);
    const hit = results.find((r) => r.ruleId === 'secret-stripe-live');
    expect(hit).toBeDefined();
    expect(hit?.file).toBe('deeply/nested/module/config.py');
    expect(hit?.lineNumber).toBe(88);
  });

  it('does not double-report a secret that is in both the sample and the full-repo candidates', () => {
    const ctx: RepoAnalysisContext = {
      ...baseCtx('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', '.env'),
      fullRepoSecretCandidates: [
        {
          path: '.env',
          lineNumber: 1,
          line: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
        },
      ],
    };
    const results = evaluate(ctx);
    const hits = results.filter((r) => r.ruleId === 'secret-aws-access-key');
    expect(hits).toHaveLength(1);
  });
});
