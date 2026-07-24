import { DetectionResult, Severity, ThreatCategory } from '../../common/enums';
import { looksLikeHighEntropySecret } from '../../common/utils/entropy';
import { redactSecret, redactSecretsInText } from '../../common/utils/redact';
import { DetectionRule, RepoAnalysisContext } from './rule.types';

interface SecretPattern {
  id: string;
  name: string;
  regex: RegExp;
  severity: Severity;
  confidence: number;
  riskContribution: number;
  explanation: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'secret-aws-access-key',
    name: 'AWS Access Key ID',
    regex: /AKIA[0-9A-Z]{16}/g,
    severity: Severity.CRITICAL,
    confidence: 0.95,
    riskContribution: 35,
    explanation: 'AWS access key ID pattern detected in repository content.',
  },
  {
    id: 'secret-github-pat',
    name: 'GitHub Personal Access Token',
    regex: /(?:ghp_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{20,})/g,
    severity: Severity.CRITICAL,
    confidence: 0.95,
    riskContribution: 35,
    explanation: 'GitHub personal access token pattern detected.',
  },
  {
    id: 'secret-mongodb-uri',
    name: 'MongoDB Connection String',
    regex: /mongodb(?:\+srv)?:\/\/(?:[^@\s"'<>]+@)?[^\s"'<>]+/gi,
    severity: Severity.HIGH,
    confidence: 0.9,
    riskContribution: 28,
    explanation: 'MongoDB connection URI with potential credentials found.',
  },
  {
    id: 'secret-redis-uri',
    name: 'Redis Connection String',
    regex: /rediss?:\/\/(?:[^@\s"'<>]+@)?[^\s"'<>]+/gi,
    severity: Severity.HIGH,
    confidence: 0.88,
    riskContribution: 25,
    explanation: 'Redis connection URI pattern detected.',
  },
  {
    id: 'secret-postgres-uri',
    name: 'Postgres Connection String',
    regex: /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
    severity: Severity.HIGH,
    confidence: 0.88,
    riskContribution: 26,
    explanation: 'PostgreSQL connection URI with potential credentials found.',
  },
  {
    id: 'secret-mysql-uri',
    name: 'MySQL Connection String',
    regex: /mysql:\/\/[^\s"'<>]+/gi,
    severity: Severity.HIGH,
    confidence: 0.85,
    riskContribution: 24,
    explanation: 'MySQL connection URI with potential credentials found.',
  },
  {
    id: 'secret-firebase-key',
    name: 'Firebase API Key',
    regex: /AIza[0-9A-Za-z_-]{35}/g,
    severity: Severity.HIGH,
    confidence: 0.85,
    riskContribution: 24,
    explanation: 'Firebase/Google API key pattern detected.',
  },
  {
    id: 'secret-firebase-service-account',
    name: 'Firebase Service Account Key',
    regex:
      /"type"\s*:\s*"service_account"[\s\S]{0,500}?"private_key"\s*:\s*"-----BEGIN/g,
    severity: Severity.CRITICAL,
    confidence: 0.97,
    riskContribution: 38,
    explanation: 'Firebase/Google Cloud service account JSON key detected.',
  },
  {
    id: 'secret-gemini-key',
    name: 'Gemini API Key',
    regex: /AIzaSy[0-9A-Za-z_-]{33}/g,
    severity: Severity.CRITICAL,
    confidence: 0.95,
    riskContribution: 35,
    explanation: 'Google/Gemini API key pattern detected.',
  },
  {
    id: 'secret-stripe-live',
    name: 'Stripe Live Secret Key',
    regex: /sk_live_[A-Za-z0-9]{20,}/g,
    severity: Severity.CRITICAL,
    confidence: 0.96,
    riskContribution: 36,
    explanation: 'Stripe live secret key pattern detected.',
  },
  {
    id: 'secret-slack-token',
    name: 'Slack Token',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9-]+/g,
    severity: Severity.HIGH,
    confidence: 0.9,
    riskContribution: 28,
    explanation: 'Slack API/bot/app token pattern detected.',
  },
  {
    id: 'secret-anthropic-key',
    name: 'Anthropic API Key',
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    severity: Severity.HIGH,
    confidence: 0.9,
    riskContribution: 28,
    explanation: 'Anthropic API key pattern detected.',
  },
  {
    id: 'secret-openai-key',
    name: 'OpenAI API Key',
    regex: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g,
    severity: Severity.HIGH,
    confidence: 0.85,
    riskContribution: 28,
    explanation: 'OpenAI API key pattern detected.',
  },
  {
    id: 'secret-discord-bot',
    name: 'Discord Bot Token',
    regex: /[MN][A-Za-z0-9]{23,}\.[\w-]{6}\.[\w-]{27,}/g,
    severity: Severity.HIGH,
    confidence: 0.75,
    riskContribution: 24,
    explanation: 'Discord bot token-like pattern detected.',
  },
  {
    id: 'secret-discord-webhook',
    name: 'Discord Webhook URL',
    regex:
      /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    severity: Severity.HIGH,
    confidence: 0.9,
    riskContribution: 26,
    explanation: 'Discord webhook URL with token detected.',
  },
  {
    id: 'secret-telegram-token',
    name: 'Telegram Bot Token',
    regex: /[0-9]{8,10}:[A-Za-z0-9_-]{35}/g,
    severity: Severity.HIGH,
    confidence: 0.9,
    riskContribution: 28,
    explanation: 'Telegram Bot API token detected.',
  },
  {
    id: 'secret-twilio',
    name: 'Twilio API Key',
    regex: /SK[0-9a-fA-F]{32}/g,
    severity: Severity.HIGH,
    confidence: 0.8,
    riskContribution: 24,
    explanation: 'Twilio-style API key pattern detected.',
  },
  {
    id: 'secret-sendgrid',
    name: 'SendGrid API Key',
    regex: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    severity: Severity.HIGH,
    confidence: 0.9,
    riskContribution: 26,
    explanation: 'SendGrid API key pattern detected.',
  },
  {
    id: 'secret-jwt',
    name: 'JWT Token',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    severity: Severity.MEDIUM,
    confidence: 0.78,
    riskContribution: 18,
    explanation: 'JWT-like token detected in content.',
  },
  {
    id: 'secret-api-jwt-bearer',
    name: 'JWT / API Bearer Token',
    regex:
      /(?:jwt|api[_-]?token|access[_-]?token|bearer)\s*[:=]\s*['"]?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}['"]?/gi,
    severity: Severity.HIGH,
    confidence: 0.85,
    riskContribution: 24,
    explanation: 'JWT or API token assignment detected.',
  },
  {
    id: 'secret-bearer-token',
    name: 'Bearer Token',
    regex: /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    severity: Severity.HIGH,
    confidence: 0.8,
    riskContribution: 22,
    explanation: 'Bearer token credential pattern detected.',
  },
  {
    id: 'secret-certificate',
    name: 'PEM Certificate block',
    regex: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    severity: Severity.MEDIUM,
    confidence: 0.9,
    riskContribution: 15,
    explanation: 'PEM certificate block detected.',
  },
  {
    id: 'secret-ssh-private-key',
    name: 'SSH Private Key',
    regex:
      /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
    severity: Severity.CRITICAL,
    confidence: 0.98,
    riskContribution: 40,
    explanation: 'PEM-encoded private key block detected.',
  },
  {
    id: 'secret-generic-api-token',
    name: 'Generic API Token',
    regex:
      /(?:api[_-]?key|api[_-]?token|access[_-]?token|secret[_-]?key|auth[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{16,}['"]?/gi,
    severity: Severity.HIGH,
    confidence: 0.7,
    riskContribution: 22,
    explanation: 'Generic API token or secret assignment detected.',
  },
];

const PATH_SECRET_BOOST =
  /(^|\/)(\.env|.*credentials.*|.*secret.*|firebase\.json|google-services\.json|serviceaccount\.json|id_rsa|id_ed25519|\.npmrc|\.pypirc|netrc|.*\.pem$|.*\.key$)/i;

const ASSIGNMENT_RE =
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|bearer)\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{20,})['"]?/gi;

function collectHaystacks(
  ctx: RepoAnalysisContext,
): Array<{ source: string; text: string; pathBoost: boolean }> {
  const items: Array<{ source: string; text: string; pathBoost: boolean }> = [
    {
      source: 'description',
      text: ctx.description || '',
      pathBoost: false,
    },
    { source: 'readme', text: ctx.readmeText || '', pathBoost: false },
  ];
  for (const file of ctx.smallFileTexts) {
    items.push({
      source: file.path,
      text: file.content,
      pathBoost: PATH_SECRET_BOOST.test(file.path),
    });
  }
  return items;
}

function pathBoosted(
  base: Pick<
    SecretPattern,
    'severity' | 'confidence' | 'riskContribution' | 'explanation'
  >,
  boosted: boolean,
): Pick<
  SecretPattern,
  'severity' | 'confidence' | 'riskContribution' | 'explanation'
> {
  if (!boosted) return base;
  const severity =
    base.severity === Severity.MEDIUM ? Severity.HIGH : base.severity;
  return {
    severity,
    confidence: Math.min(0.99, base.confidence + 0.05),
    riskContribution: Math.min(45, base.riskContribution + 6),
    explanation: `${base.explanation} Path suggests a secrets file.`,
  };
}

export const secretDetectionRule: DetectionRule = {
  id: 'secrets-bundle',
  name: 'Exposed Secrets Detector',
  evaluate(ctx: RepoAnalysisContext): DetectionResult[] {
    const results: DetectionResult[] = [];
    const haystacks = collectHaystacks(ctx);
    const seenRuleIds = new Set<string>();

    for (const pattern of SECRET_PATTERNS) {
      for (const { source, text, pathBoost } of haystacks) {
        if (!text) continue;
        const lines = text.split(/\r?\n/);
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matches = line.match(pattern.regex);
          if (matches?.length) {
            const sample = matches[0];
            const boosted = pathBoosted(pattern, pathBoost);
            results.push({
              ruleId: pattern.id,
              ruleName: pattern.name,
              category: ThreatCategory.EXPOSED_SECRET,
              severity: boosted.severity,
              confidence: boosted.confidence,
              evidence: `Found in ${source} on line ${i + 1}: ${redactSecretsInText(redactSecret(line.trim()))}`,
              explanation: boosted.explanation,
              riskContribution: boosted.riskContribution,
              file: source,
              lineNumber: i + 1,
              matchedText: redactSecretsInText(redactSecret(sample)),
            });
            seenRuleIds.add(pattern.id);
            found = true;
            break;
          }
        }
        if (found) break; // one hit per pattern is enough
      }
    }

    // Entropy heuristic for unknown token assignments
    if (!seenRuleIds.has('secret-high-entropy-assignment')) {
      for (const { source, text, pathBoost } of haystacks) {
        if (!text) continue;
        const lines = text.split(/\r?\n/);
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          ASSIGNMENT_RE.lastIndex = 0;
          const match = ASSIGNMENT_RE.exec(line);
          if (match !== null) {
            const value = match[1];
            if (!looksLikeHighEntropySecret(value)) continue;
            const boosted = pathBoosted(
              {
                severity: Severity.HIGH,
                confidence: 0.65,
                riskContribution: 20,
                explanation:
                  'High-entropy value assigned to a secret-like variable.',
              },
              pathBoost,
            );
            results.push({
              ruleId: 'secret-high-entropy-assignment',
              ruleName: 'High-Entropy Secret Assignment',
              category: ThreatCategory.EXPOSED_SECRET,
              severity: boosted.severity,
              confidence: boosted.confidence,
              evidence: `Found in ${source} on line ${i + 1}: ${redactSecretsInText(line.trim())}`,
              explanation: boosted.explanation,
              riskContribution: boosted.riskContribution,
              file: source,
              lineNumber: i + 1,
              matchedText: redactSecretsInText(match[0]),
            });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    return results;
  },
};
