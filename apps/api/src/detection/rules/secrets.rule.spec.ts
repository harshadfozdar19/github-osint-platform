import { secretDetectionRule } from './secrets.rule';
import { RepoAnalysisContext } from './rule.types';
import { DetectionResult, ThreatCategory } from '../../common/enums';

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
});
