import {
  DetectionResult,
  Severity,
  SUSPICIOUS_KEYWORDS,
  ThreatCategory,
} from '../../common/enums';
import { DetectionRule, RepoAnalysisContext } from './rule.types';

const PHISHING_TERMS = [
  'phishing',
  'phish',
  'login page',
  'verify account',
  'otp bypass',
  '2fa bypass',
  'credential harvest',
  'fake login',
  'account recovery kit',
];

const MALWARE_TERMS = [
  'malware',
  'rat ',
  'stealer',
  'keylogger',
  'botnet',
  'ransomware',
  'crypter',
  'payload dropper',
  'obfuscated',
];

const APK_HINTS = [
  '.apk',
  'android',
  'apktool',
  'smali',
  'mod apk',
  'cracked apk',
];

function textBlob(ctx: RepoAnalysisContext): string {
  return [
    ctx.fullName,
    ctx.description,
    ctx.topics.join(' '),
    ctx.readmeText,
    ctx.filePaths.join(' '),
  ]
    .join(' ')
    .toLowerCase();
}

function brandPresent(ctx: RepoAnalysisContext, blob: string): string | null {
  if (ctx.matchedBrandName) {
    const aliases = [
      ctx.matchedBrandName.toLowerCase(),
      ...(ctx.matchedBrandAliases || []).map((a) => a.toLowerCase()),
    ];
    if (aliases.some((a) => blob.includes(a))) return ctx.matchedBrandName;
  }
  return null;
}

export const brandImpersonationRule: DetectionRule = {
  id: 'brand-impersonation',
  name: 'Brand Impersonation',
  evaluate(ctx): DetectionResult | null {
    const blob = textBlob(ctx);
    const brand = brandPresent(ctx, blob);
    if (!brand) return null;

    const suspiciousHits = SUSPICIOUS_KEYWORDS.filter((k) =>
      blob.includes(k.toLowerCase()),
    );
    if (suspiciousHits.length === 0) return null;

    // Official-looking orgs with high stars are less likely impersonation
    const ownerLooksOfficial =
      ctx.owner.toLowerCase() === brand.toLowerCase().replace(/\s+/g, '') ||
      ctx.stars >= 500;

    if (ownerLooksOfficial && suspiciousHits.length < 2) return null;

    return {
      ruleId: 'brand-impersonation',
      ruleName: 'Brand Impersonation',
      category: ThreatCategory.BRAND_IMPERSONATION,
      severity: suspiciousHits.length >= 3 ? Severity.HIGH : Severity.MEDIUM,
      confidence: Math.min(0.9, 0.55 + suspiciousHits.length * 0.1),
      evidence: `Brand "${brand}" with suspicious terms: ${suspiciousHits.slice(0, 5).join(', ')}`,
      explanation: `Repository references monitored brand "${brand}" alongside suspicious keywords commonly used in impersonation campaigns.`,
      riskContribution: 20 + Math.min(15, suspiciousHits.length * 4),
    };
  },
};

export const phishingRule: DetectionRule = {
  id: 'phishing-kit',
  name: 'Phishing Indicators',
  evaluate(ctx): DetectionResult | null {
    const blob = textBlob(ctx);
    const hits = PHISHING_TERMS.filter((t) => blob.includes(t));
    const brand = brandPresent(ctx, blob);
    if (
      hits.length === 0 &&
      !(brand && (blob.includes('login') || blob.includes('verify')))
    ) {
      return null;
    }

    const strength = hits.length + (brand ? 1 : 0);
    if (strength < 1) return null;

    return {
      ruleId: 'phishing-kit',
      ruleName: 'Phishing Indicators',
      category: ThreatCategory.PHISHING,
      severity: strength >= 2 ? Severity.CRITICAL : Severity.HIGH,
      confidence: Math.min(0.92, 0.6 + strength * 0.1),
      evidence: `Phishing signals: ${[...hits, brand ? `brand=${brand}` : ''].filter(Boolean).join(', ')}`,
      explanation:
        'Repository metadata or content suggests phishing kit / credential harvesting behavior.',
      riskContribution: 25 + Math.min(20, strength * 6),
    };
  },
};

export const fakeApkRule: DetectionRule = {
  id: 'fake-apk',
  name: 'Fake Android / APK',
  evaluate(ctx): DetectionResult | null {
    const blob = textBlob(ctx);
    const brand = brandPresent(ctx, blob);
    const apkSignals = APK_HINTS.filter((h) => blob.includes(h));
    const hasApkFile = ctx.filePaths.some((p) =>
      p.toLowerCase().endsWith('.apk'),
    );

    if (!brand || (apkSignals.length === 0 && !hasApkFile)) return null;

    return {
      ruleId: 'fake-apk',
      ruleName: 'Fake Android / APK',
      category: ThreatCategory.FAKE_APK,
      severity: hasApkFile ? Severity.CRITICAL : Severity.HIGH,
      confidence: hasApkFile ? 0.9 : 0.75,
      evidence: `Brand "${brand}"; APK signals: ${[...apkSignals, hasApkFile ? '.apk file' : ''].filter(Boolean).join(', ')}`,
      explanation:
        'Android/APK artifacts combined with a monitored brand name — possible fake banking/trading app.',
      riskContribution: hasApkFile ? 32 : 24,
    };
  },
};

export const malwareRule: DetectionRule = {
  id: 'malware-indicators',
  name: 'Malware Indicators',
  evaluate(ctx): DetectionResult | null {
    const blob = textBlob(ctx);
    const hits = MALWARE_TERMS.filter((t) => blob.includes(t));
    const scripty =
      ctx.filePaths.some((p) => /\.(ps1|bat|cmd|vbs|exe|dll|scr)$/i.test(p)) &&
      (blob.includes('crack') ||
        blob.includes('bypass') ||
        blob.includes('payload'));

    if (hits.length === 0 && !scripty) return null;

    return {
      ruleId: 'malware-indicators',
      ruleName: 'Malware Indicators',
      category: ThreatCategory.MALWARE,
      severity: hits.length >= 2 || scripty ? Severity.CRITICAL : Severity.HIGH,
      confidence: 0.7,
      evidence: `Malware-related terms/files: ${[...hits, scripty ? 'suspicious executables' : ''].filter(Boolean).join(', ')}`,
      explanation:
        'Repository shows malware-related terminology or suspicious executable patterns.',
      riskContribution: 28 + Math.min(12, hits.length * 4),
    };
  },
};

export const lowReputationRule: DetectionRule = {
  id: 'low-reputation-new-repo',
  name: 'Low Reputation / Newly Created',
  evaluate(ctx): DetectionResult | null {
    const brand = brandPresent(ctx, textBlob(ctx));
    if (!brand) return null;

    const ageDays = ctx.githubCreatedAt
      ? (Date.now() - ctx.githubCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
      : 999;

    const lowStars = ctx.stars <= 2;
    const newRepo = ageDays <= 30;

    if (!lowStars && !newRepo) return null;

    return {
      ruleId: 'low-reputation-new-repo',
      ruleName: 'Low Reputation / Newly Created',
      category: ThreatCategory.SUSPICIOUS_REPO,
      severity: Severity.LOW,
      confidence: 0.55,
      evidence: `Brand "${brand}", stars=${ctx.stars}, ageDays≈${Math.round(ageDays)}`,
      explanation:
        'Recently created or low-activity repository using a monitored brand increases suspicion when combined with other signals.',
      riskContribution: newRepo && lowStars ? 12 : 8,
    };
  },
};

export const obfuscationRule: DetectionRule = {
  id: 'obfuscated-commands',
  name: 'Obfuscated / Encoded Commands',
  evaluate(ctx): DetectionResult | null {
    const patterns = [
      /powershell\s+-enc\s+/i,
      /frombase64string/i,
      /eval\s*\(\s*atob\s*\(/i,
      /base64\s+-d/i,
      /\[system\.convert\]::frombase64string/i,
    ];

    for (const file of ctx.smallFileTexts) {
      const lines = file.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hit = patterns.find((p) => p.test(line));
        if (hit) {
          return {
            ruleId: 'obfuscated-commands',
            ruleName: 'Obfuscated / Encoded Commands',
            category: ThreatCategory.MALWARE,
            severity: Severity.HIGH,
            confidence: 0.8,
            evidence: `Encoded/obfuscated command pattern found in ${file.path} on line ${i + 1}`,
            explanation:
              'Obfuscated or base64-encoded command patterns often accompany malware staging scripts.',
            riskContribution: 22,
            file: file.path,
            lineNumber: i + 1,
            matchedText: 'Encoded/obfuscated command pattern',
          };
        }
      }
    }

    const readmeLines = ctx.readmeText.split(/\r?\n/);
    for (let i = 0; i < readmeLines.length; i++) {
      const line = readmeLines[i];
      const hit = patterns.find((p) => p.test(line));
      if (hit) {
        return {
          ruleId: 'obfuscated-commands',
          ruleName: 'Obfuscated / Encoded Commands',
          category: ThreatCategory.MALWARE,
          severity: Severity.HIGH,
          confidence: 0.8,
          evidence: `Encoded/obfuscated command pattern found in README on line ${i + 1}`,
          explanation:
            'Obfuscated or base64-encoded command patterns often accompany malware staging scripts.',
          riskContribution: 22,
          file: 'README.md',
          lineNumber: i + 1,
          matchedText: 'Encoded/obfuscated command pattern',
        };
      }
    }

    return null;
  },
};
