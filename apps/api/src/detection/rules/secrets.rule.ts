import { createHash } from 'crypto';
import { DetectionResult, Severity, ThreatCategory } from '../../common/enums';
import {
  looksLikeCodeReference,
  looksLikeHighEntropySecret,
  looksLikePlaceholderValue,
} from '../../common/utils/entropy';
import { redactSecret, redactSecretsInText } from '../../common/utils/redact';
import { DetectionRule, RepoAnalysisContext } from './rule.types';

export interface SecretPattern {
  id: string;
  name: string;
  regex: RegExp;
  severity: Severity;
  confidence: number;
  riskContribution: number;
  explanation: string;
}

export const SECRET_PATTERNS: SecretPattern[] = [
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

/**
 * Literal substrings that MUST appear on a line for the corresponding
 * pattern to have any chance of matching - used as a cheap `git grep -F`
 * pre-filter so a full, unsampled repo can be searched for secrets without
 * running every regex against every line of every file. A grep hit is not
 * itself a finding - findFullRepoSecretMatches always re-applies the real
 * regex to confirm it before reporting anything. Patterns not listed here
 * either have no anchor precise enough to be worth pre-filtering on (too
 * short/noisy) or require multi-line context a single grepped line can never
 * satisfy (see SINGLE_LINE_INELIGIBLE_PATTERN_IDS below) - those stay
 * sample-only, checked only within the maxFiles-capped smallFileTexts.
 */
export const SECRET_GREP_ANCHORS: string[] = [
  'AKIA',
  'ghp_',
  'github_pat_',
  'mongodb://',
  'mongodb+srv://',
  'redis://',
  'rediss://',
  'postgres://',
  'postgresql://',
  'mysql://',
  'AIza',
  'sk_live_',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxr-',
  'xoxs-',
  'xapp-',
  'sk-ant-',
  'sk-proj-',
  'sk-',
  'discord.com/api/webhooks/',
  'discordapp.com/api/webhooks/',
  'SG.',
  'eyJ',
  'bearer ',
  'api_key',
  'api-key',
  'apikey',
  'api_token',
  'api-token',
  'apitoken',
  'access_token',
  'access-token',
  'accesstoken',
  'secret_key',
  'secret-key',
  'secretkey',
  'auth_token',
  'auth-token',
  'authtoken',
];

/**
 * A PEM private-key header line ("-----BEGIN RSA PRIVATE KEY-----" etc.) is
 * unambiguous proof of a private key on its own - unlike the closing
 * "-----END...-----" body, nothing benign ever produces this exact line by
 * coincidence. So unlike every other pattern here, a grep hit on one of
 * these anchors is reported directly, without needing (or being able to,
 * from one line) match the full multi-line secret-ssh-private-key regex.
 */
export const PRIVATE_KEY_ANCHORS: string[] = [
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN DSA PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----',
];

/**
 * Patterns whose regex spans multiple lines ([\s\S]*? between a start and
 * end marker) - a single grepped line can contain the start of a match but
 * can never satisfy the full pattern on its own, so re-testing them against
 * one line at a time would only ever silently fail. Excluded from the
 * full-repo pass entirely rather than producing a confusing always-empty
 * check; secret-ssh-private-key gets its own anchor-only handling above
 * instead since its start marker alone is already conclusive.
 */
const SINGLE_LINE_INELIGIBLE_PATTERN_IDS = new Set([
  'secret-firebase-service-account',
  'secret-certificate',
  'secret-ssh-private-key',
]);

export interface FullRepoSecretCandidate {
  path: string;
  lineNumber: number;
  line: string;
}

const PATH_SECRET_BOOST =
  /(^|\/)(\.env|.*credentials.*|.*secret.*|firebase\.json|google-services\.json|serviceaccount\.json|id_rsa|id_ed25519|\.npmrc|\.pypirc|netrc|.*\.pem$|.*\.key$)/i;

const ASSIGNMENT_RE =
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|bearer)\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{20,})['"]?/gi;

export function collectHaystacks(
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

/**
 * `source` from collectHaystacks is a real repo file path only for
 * smallFileTexts entries - 'readme' and 'description' are haystack labels,
 * not paths, and linking to them literally (e.g. ".../blob/HEAD/readme")
 * 404s since GitHub is case-sensitive and the real README's name/extension
 * varies per repo. Resolve to the actual on-disk path where known, and drop
 * the file link entirely for 'description' since it was never a real file.
 */
export function resolveEvidenceFile(
  source: string,
  ctx: RepoAnalysisContext,
): string | undefined {
  if (source === 'description') return undefined;
  if (source === 'readme') return ctx.readmePath || 'README.md';
  return source;
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

// Safety cap, not an expected ceiling - a single noisy pattern (e.g. the
// generic API-token regex) matching dozens of times in one repo shouldn't
// balloon a finding into an unreadable wall of near-duplicate evidence.
// Legitimate distinct leaks (different files, different keys) are almost
// never anywhere near this number.
const MAX_MATCHES_PER_PATTERN = 10;
const MAX_ENTROPY_MATCHES = 10;

const PRIVATE_KEY_LINE_RE =
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/;

/**
 * secret-generic-api-token's value charset (letters/digits/`_-/.+=`) is
 * loose enough to also match source code on the right-hand side of an
 * assignment instead of a literal secret - `api_key=settings.openai_api_key`
 * isn't a leaked key, it's code reading one from config, and
 * `accessToken=generateAccessToken(user)` isn't either, it's a function
 * call (the char class simply can't include "(", so the match silently
 * truncates right before it). Same charset also happily matches an
 * obviously-fake example value like `api_key: 'your_api_key'` or
 * `access_token: 'sampleAccessToken'` - the kind of placeholder that fills
 * READMEs and sample config, not a real leak. secret-bearer-token has the
 * same problem for the same reason (`Bearer sample_token_here` fits its
 * charset just as well as a real token). Pulls the assigned/passed value
 * back out of the full match text (neither regex has a capture group, to
 * keep `matches[0]` usable as evidence everywhere else) and checks all three
 * shapes. Only meaningful for these two patterns: every other named
 * pattern's format (AWS key, Stripe key, connection URI, ...) has a fixed
 * vendor-specific prefix/shape that placeholder text or code references can
 * never structurally satisfy by coincidence.
 */
const LOOSE_VALUE_PATTERN_IDS = new Set([
  'secret-generic-api-token',
  'secret-bearer-token',
]);

const GENERIC_TOKEN_VALUE_RE = /[:=]\s*['"]?([A-Za-z0-9_\-/.+=]+)['"]?$/;
const BEARER_TOKEN_VALUE_RE = /bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i;

function extractLooseSecretValue(
  patternId: string,
  fullMatchText: string,
): string | null {
  if (patternId === 'secret-bearer-token') {
    return fullMatchText.match(BEARER_TOKEN_VALUE_RE)?.[1] ?? null;
  }
  return fullMatchText.match(GENERIC_TOKEN_VALUE_RE)?.[1] ?? null;
}

function isLooseSecretPatternNonMatch(
  patternId: string,
  fullMatchText: string,
  line: string,
): boolean {
  const value = extractLooseSecretValue(patternId, fullMatchText);
  if (value == null) return false;
  if (looksLikeCodeReference(value)) return true;
  if (looksLikePlaceholderValue(value)) return true;
  // The match ended exactly where the source continues with "(" - the
  // "value" is actually the start of a function call, not a literal.
  return line.includes(`${fullMatchText}(`);
}

/**
 * Re-verifies real secret-pattern regexes against every line git grep found
 * a literal anchor on across the WHOLE repo tree - the anchors themselves
 * are only a fast pre-filter (see SECRET_GREP_ANCHORS) and are never treated
 * as findings on their own. `alreadyReported` prevents double-counting a
 * secret that was also visible through the maxFiles-capped sample, and
 * `sampleMatchCounts` carries over MAX_MATCHES_PER_PATTERN as one combined
 * budget across both passes rather than resetting it for this pass alone.
 */
export function findFullRepoSecretMatches(
  candidates: FullRepoSecretCandidate[],
  alreadyReported: ReadonlySet<string>,
  sampleMatchCounts: ReadonlyMap<string, number>,
): DetectionResult[] {
  const results: DetectionResult[] = [];
  const seen = new Set<string>(alreadyReported);
  const counts = new Map<string, number>(sampleMatchCounts);

  for (const { path, lineNumber, line } of candidates) {
    // The PEM header line alone is conclusive - can't wait for the closing
    // "-----END...-----" marker since that may be many files/lines away in
    // whatever a single grep hit line is.
    if (PRIVATE_KEY_LINE_RE.test(line)) {
      const key = `${path}:${lineNumber}:secret-ssh-private-key`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          ruleId: 'secret-ssh-private-key',
          ruleName: 'SSH Private Key',
          category: ThreatCategory.EXPOSED_SECRET,
          severity: Severity.CRITICAL,
          confidence: 0.98,
          evidence: `Found in ${path} on line ${lineNumber}: ${line.trim()}`,
          explanation: 'PEM-encoded private key header detected.',
          riskContribution: 40,
          file: path,
          lineNumber,
          matchedText: line.trim(),
        });
      }
    }

    for (const pattern of SECRET_PATTERNS) {
      if (SINGLE_LINE_INELIGIBLE_PATTERN_IDS.has(pattern.id)) continue;
      const key = `${path}:${lineNumber}:${pattern.id}`;
      if (seen.has(key)) continue;
      const count = counts.get(pattern.id) || 0;
      if (count >= MAX_MATCHES_PER_PATTERN) continue;

      const matches = line.match(pattern.regex);
      if (!matches?.length) continue;
      if (
        LOOSE_VALUE_PATTERN_IDS.has(pattern.id) &&
        isLooseSecretPatternNonMatch(pattern.id, matches[0], line)
      ) {
        continue;
      }

      seen.add(key);
      counts.set(pattern.id, count + 1);
      const boosted = pathBoosted(pattern, PATH_SECRET_BOOST.test(path));
      results.push({
        ruleId: pattern.id,
        ruleName: pattern.name,
        category: ThreatCategory.EXPOSED_SECRET,
        severity: boosted.severity,
        confidence: boosted.confidence,
        evidence: `Found in ${path} on line ${lineNumber}: ${redactSecretsInText(redactSecret(line.trim()))}`,
        explanation: boosted.explanation,
        riskContribution: boosted.riskContribution,
        file: path,
        lineNumber,
        matchedText: redactSecretsInText(redactSecret(matches[0])),
      });
    }
  }

  return results;
}

export const secretDetectionRule: DetectionRule = {
  id: 'secrets-bundle',
  name: 'Exposed Secrets Detector',
  evaluate(ctx: RepoAnalysisContext): DetectionResult[] {
    const results: DetectionResult[] = [];
    const haystacks = collectHaystacks(ctx);
    const seenRuleIds = new Set<string>();
    // "path:lineNumber:ruleId" of every match already reported here, so the
    // full-repo pass below (which searches the WHOLE tree, a superset that
    // includes these same sampled files) never double-reports the same
    // secret it already found through the capped sample.
    const dedupKeys = new Set<string>();
    const matchCounts = new Map<string, number>();

    // Every occurrence of every pattern is reported, not just the first one
    // found overall - a repo can leak the same kind of credential (or
    // different credentials of the same kind) in more than one file, and an
    // analyst needs to see each location to know the full blast radius.
    for (const pattern of SECRET_PATTERNS) {
      let matchCount = 0;
      for (const { source, text, pathBoost } of haystacks) {
        if (!text) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matchCount >= MAX_MATCHES_PER_PATTERN) break;
          const line = lines[i];
          const matches = line.match(pattern.regex);
          if (
            matches?.length &&
            LOOSE_VALUE_PATTERN_IDS.has(pattern.id) &&
            isLooseSecretPatternNonMatch(pattern.id, matches[0], line)
          ) {
            continue;
          }
          if (matches?.length) {
            const sample = matches[0];
            const boosted = pathBoosted(pattern, pathBoost);
            const file = resolveEvidenceFile(source, ctx);
            results.push({
              ruleId: pattern.id,
              ruleName: pattern.name,
              category: ThreatCategory.EXPOSED_SECRET,
              severity: boosted.severity,
              confidence: boosted.confidence,
              evidence: `Found in ${source} on line ${i + 1}: ${redactSecretsInText(redactSecret(line.trim()))}`,
              explanation: boosted.explanation,
              riskContribution: boosted.riskContribution,
              file,
              lineNumber: i + 1,
              matchedText: redactSecretsInText(redactSecret(sample)),
            });
            seenRuleIds.add(pattern.id);
            matchCount += 1;
            if (file) dedupKeys.add(`${file}:${i + 1}:${pattern.id}`);
          }
        }
        if (matchCount >= MAX_MATCHES_PER_PATTERN) break;
      }
      matchCounts.set(pattern.id, matchCount);
    }

    // Full-repo pass: the same patterns, but over every file git grep found
    // an anchor in across the WHOLE repo tree - not just the maxFiles-capped
    // sample above. Only runs when clone-based scanning actually populated
    // candidates (ctx.fullRepoSecretCandidates); a no-op otherwise, same as
    // every other clone-only signal in this codebase.
    if (ctx.fullRepoSecretCandidates?.length) {
      results.push(
        ...findFullRepoSecretMatches(
          ctx.fullRepoSecretCandidates,
          dedupKeys,
          matchCounts,
        ),
      );
    }

    // Entropy heuristic for unknown token assignments - skipped entirely
    // when a named pattern above already matched anywhere in the repo, to
    // avoid double-flagging the same underlying leak as both a specific
    // known secret type and a generic high-entropy guess.
    if (!seenRuleIds.has('secret-high-entropy-assignment')) {
      let matchCount = 0;
      for (const { source, text, pathBoost } of haystacks) {
        if (!text) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matchCount >= MAX_ENTROPY_MATCHES) break;
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
              file: resolveEvidenceFile(source, ctx),
              lineNumber: i + 1,
              matchedText: redactSecretsInText(match[0]),
            });
            matchCount += 1;
          }
        }
        if (matchCount >= MAX_ENTROPY_MATCHES) break;
      }
    }

    return results;
  },
};

/**
 * Looks up the same pattern a detection was originally found with, so a
 * later "verify this credential" action can re-apply the exact regex to
 * freshly re-fetched file content instead of trusting a possibly-stale
 * stored (and already-redacted) match.
 */
export function getSecretPatternById(ruleId: string): SecretPattern | null {
  return SECRET_PATTERNS.find((p) => p.id === ruleId) || null;
}

export interface CredentialReuseMatch {
  patternId: string;
  patternName: string;
  file?: string;
  lineNumber: number;
  evidence: string;
}

// A hash-set lookup per match is cheap; this bounds pathological repeat
// content the same way MAX_MATCHES_PER_PATTERN/MAX_ENTROPY_MATCHES do above.
const MAX_REUSE_MATCHES = 20;

/**
 * Cross-checks secret values found in this repo's content against a set of
 * sha256 hashes of a brand's OWN known credential values (built from the
 * brand's reference repos - see fingerprints/known-secret.util.ts). A hit
 * here is materially stronger evidence than a normal secretDetectionRule
 * match: it proves this repo has the brand's actual credential value, not
 * merely "a secret shaped like an AWS key". Reuses the exact same haystacks
 * and patterns as secretDetectionRule so a value is only ever compared
 * against the same text it would otherwise be flagged from. Never receives,
 * stores, or exposes any raw known-secret value - only pre-computed hashes
 * go in, and only a hash of what's found here is ever compared against them.
 */
export function findCredentialReuseMatches(
  ctx: RepoAnalysisContext,
  knownValueHashes: ReadonlySet<string>,
): CredentialReuseMatch[] {
  if (knownValueHashes.size === 0) return [];

  const results: CredentialReuseMatch[] = [];
  const haystacks = collectHaystacks(ctx);

  for (const pattern of SECRET_PATTERNS) {
    let matchCount = 0;
    for (const { source, text } of haystacks) {
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matchCount >= MAX_REUSE_MATCHES) break;
        const matches = lines[i].match(pattern.regex);
        if (!matches?.length) continue;
        for (const sample of matches) {
          if (matchCount >= MAX_REUSE_MATCHES) break;
          const valueHash = createHash('sha256')
            .update(sample, 'utf8')
            .digest('hex');
          if (!knownValueHashes.has(valueHash)) continue;
          results.push({
            patternId: pattern.id,
            patternName: pattern.name,
            file: resolveEvidenceFile(source, ctx),
            lineNumber: i + 1,
            evidence: `Found in ${source} on line ${i + 1}: ${redactSecretsInText(redactSecret(lines[i].trim()))}`,
          });
          matchCount += 1;
        }
      }
      if (matchCount >= MAX_REUSE_MATCHES) break;
    }
  }

  return results;
}
