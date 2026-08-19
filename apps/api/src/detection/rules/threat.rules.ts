import {
  DetectionResult,
  Severity,
  SUSPICIOUS_KEYWORDS,
  ThreatCategory,
  WEAK_SUSPICIOUS_KEYWORDS,
} from '../../common/enums';
import {
  BrandMatchLocation,
  findKeywordMatches,
} from '../../common/brand-match';
import { dedupeKeywordsCaseInsensitive } from '../../common/utils/dedupe-keywords';
import {
  extractDataDestinations,
  findDeployConfigFiles,
} from './destination.util';
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

// "login page" and "verify account" are just... normal software. Any
// ordinary auth SDK, dashboard, or storage/API client repo can legitimately
// say either phrase in a README or comment with zero malicious intent (a
// "login page" component, "verify account via email"), unlike every other
// term above ("credential harvest", "fake login", "otp bypass", ...) which
// has no benign reading. Same weak-keyword treatment as
// WEAK_SUSPICIOUS_KEYWORDS in brandImpersonationRule: a weak hit alone only
// counts once it co-occurs with a monitored brand or another hit.
const WEAK_PHISHING_TERMS = ['login page', 'verify account'];

const MALWARE_TERMS = [
  'malware',
  'rat ',
  'stealer',
  'keylogger',
  'botnet',
  'ransomware',
  'crypter',
  'payload dropper',
];

// "obfuscated" alone shows up constantly in completely benign contexts - JS
// minifier/bundler output, code-protection tooling docs, a security team's
// own writeup of *other* people's malware. Only counts toward malware
// classification once it co-occurs with a real malware term or the
// scripty+crack/bypass/payload combo below, same weak-keyword treatment as
// WEAK_SUSPICIOUS_KEYWORDS in brandImpersonationRule.
const WEAK_MALWARE_TERMS = ['obfuscated'];

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
    // Actual file content (the maxFiles-capped sample) and full-repo grep
    // hits (uncapped, when the clone-scan path ran) - without these, a
    // brand mention that only shows up deep in a file's content, alongside
    // phishing/APK/malware terms on the same line, would never combine into
    // a single signal here even though the deep scan already found it.
    ...ctx.smallFileTexts.map((f) => f.content),
    ...(ctx.brandFileMatches || []).map((m) => m.line),
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

/**
 * True when `term` appears in `haystackLower` as a whole word/phrase, not
 * merely as a substring - `mod` must not match inside `modal`/`model`/
 * `module`/`modern`. Boundary is "start/end of string or a non-alphanumeric
 * character", matching the same separator convention brand-match.ts's own
 * tokenize() already uses (so a hyphen or space breaks a word the same way
 * in both places; unlike a raw regex `\b`, this treats `_` as a separator
 * too - `zerodha_clone` should count `zerodha` as its own word, not one
 * fused token with the underscore).
 */
function matchesWholeTerm(haystackLower: string, term: string): boolean {
  const escaped = term
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(
    haystackLower,
  );
}

interface ProximityUnit {
  text: string;
  file?: string;
  lineNumber?: number;
}

/**
 * Breaks a repo down into individually-checkable units (one line of a
 * file/README, one file path, the description, ...) instead of one giant
 * concatenated blob - textBlob() above is fine for "does X appear ANYWHERE
 * in this repo" questions, but brand-impersonation specifically claims the
 * brand name and a suspicious term appear TOGETHER, which the flat-blob
 * approach never actually verified: a blog post mentioning "Zerodha" and an
 * unrelated `login` button 40 files away would both land in the same blob
 * and read as "brand + suspicious keywords co-occur" even though nothing
 * about the repo is actually impersonating the brand. Checking each unit
 * independently is what makes the resulting evidence (file/line) honest -
 * it's the exact place both things were actually found together, not a
 * borrowed pointer to wherever the brand name happened to turn up.
 */
function collectProximityUnits(ctx: RepoAnalysisContext): ProximityUnit[] {
  const units: ProximityUnit[] = [
    { text: ctx.fullName },
    { text: ctx.description },
    { text: ctx.topics.join(' ') },
    ...ctx.filePaths.map((p) => ({ text: p })),
  ];
  if (ctx.readmeText) {
    ctx.readmeText.split(/\r?\n/).forEach((line, i) => {
      units.push({
        text: line,
        file: ctx.readmePath || 'README.md',
        lineNumber: i + 1,
      });
    });
  }
  for (const f of ctx.smallFileTexts) {
    f.content.split(/\r?\n/).forEach((line, i) => {
      units.push({ text: line, file: f.path, lineNumber: i + 1 });
    });
  }
  // Full-repo git-grep hits (clone-scan path only) - each already IS one
  // line, so it's already the right granularity as-is.
  for (const m of ctx.brandFileMatches || []) {
    units.push({ text: m.line, file: m.path, lineNumber: m.lineNumber });
  }
  return units;
}

export const brandImpersonationRule: DetectionRule = {
  id: 'brand-impersonation',
  name: 'Brand Impersonation',
  evaluate(ctx): DetectionResult | null {
    if (!ctx.matchedBrandName) return null;
    const brand = ctx.matchedBrandName;
    const aliases = [
      brand.toLowerCase(),
      ...(ctx.matchedBrandAliases || []).map((a) => a.toLowerCase()),
    ];

    // Brand mention and suspicious term must appear in the SAME unit (one
    // line, one file path, the description, ...) - not just somewhere in
    // the repo each. A blog post mentioning "Zerodha" and an unrelated
    // `login` button 40 files away both landing in one flat blob used to
    // read as "brand + suspicious keywords co-occur" even though nothing
    // about the repo actually impersonates the brand. See
    // collectProximityUnits.
    const units = collectProximityUnits(ctx);
    const suspiciousHitsSet = new Set<string>();
    let bestUnit: ProximityUnit | null = null;
    let bestUnitHitCount = 0;
    for (const unit of units) {
      if (!unit.text) continue;
      const lower = unit.text.toLowerCase();
      if (!aliases.some((a) => matchesWholeTerm(lower, a))) continue;
      const hitsHere = SUSPICIOUS_KEYWORDS.filter((k) =>
        matchesWholeTerm(lower, k),
      );
      if (hitsHere.length === 0) continue;
      hitsHere.forEach((h) => suspiciousHitsSet.add(h));
      if (hitsHere.length > bestUnitHitCount) {
        bestUnit = unit;
        bestUnitHitCount = hitsHere.length;
      }
    }
    if (!bestUnit) return null;
    const suspiciousHits = [...suspiciousHitsSet];

    // A generic term like "support", "mod", or "clone" next to a brand
    // mention is too common in ordinary, legitimate repos (a support-bot
    // repo, a game mod, an open-source project's clone) to mean anything by
    // itself - only treat it as an impersonation signal once it co-occurs
    // with at least one other hit (weak or strong).
    const onlyWeakHits = suspiciousHits.every((k) =>
      (WEAK_SUSPICIOUS_KEYWORDS as readonly string[]).includes(k),
    );
    if (onlyWeakHits && suspiciousHits.length < 2) return null;

    // Official-looking orgs with high stars are less likely impersonation
    const ownerLooksOfficial =
      ctx.owner.toLowerCase() === brand.toLowerCase().replace(/\s+/g, '') ||
      ctx.stars >= 500;

    if (ownerLooksOfficial && suspiciousHits.length < 2) return null;

    const locationSuffix = bestUnit.file
      ? ` (found together in ${bestUnit.file}${bestUnit.lineNumber ? `:${bestUnit.lineNumber}` : ''})`
      : '';

    return {
      ruleId: 'brand-impersonation',
      ruleName: 'Brand Impersonation',
      category: ThreatCategory.BRAND_IMPERSONATION,
      severity: suspiciousHits.length >= 3 ? Severity.HIGH : Severity.MEDIUM,
      confidence: Math.min(0.9, 0.55 + suspiciousHits.length * 0.1),
      evidence: `Brand "${brand}" with suspicious terms: ${suspiciousHits.slice(0, 5).join(', ')}${locationSuffix}`,
      explanation: `Repository references monitored brand "${brand}" alongside suspicious keywords commonly used in impersonation campaigns, found together in the same location rather than scattered unrelated mentions.`,
      riskContribution: 20 + Math.min(15, suspiciousHits.length * 4),
      file: bestUnit.file,
      lineNumber: bestUnit.lineNumber,
    };
  },
};

export const phishingRule: DetectionRule = {
  id: 'phishing-kit',
  name: 'Phishing Indicators',
  evaluate(ctx): DetectionResult | null {
    const blob = textBlob(ctx);
    // Requires an actual phishing term, not just "brand name + login/verify"
    // - that combination is the normal shape of any fintech's own auth SDK
    // (an official trading API README talking about "login" and OTP
    // "verification" isn't evidence of anything). brandImpersonationRule
    // already covers brand + weak-keyword combinations with proper
    // official-owner gating; duplicating that logic here with no gating at
    // all just misclassified the company's own repos as phishing kits.
    const hits = PHISHING_TERMS.filter((t) => blob.includes(t));
    if (hits.length === 0) return null;

    const brand = brandPresent(ctx, blob);
    const onlyWeakHits = hits.every((t) =>
      (WEAK_PHISHING_TERMS as readonly string[]).includes(t),
    );
    if (onlyWeakHits && !brand && hits.length < 2) return null;

    const strength = hits.length + (brand ? 1 : 0);

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
    const weakHits = WEAK_MALWARE_TERMS.filter((t) => blob.includes(t));
    const scripty =
      ctx.filePaths.some((p) => /\.(ps1|bat|cmd|vbs|exe|dll|scr)$/i.test(p)) &&
      (blob.includes('crack') ||
        blob.includes('bypass') ||
        blob.includes('payload'));

    // A weak-only hit (just "obfuscated", nothing else) is not enough on its
    // own - needs a real malware term or the scripty+intent combo.
    if (hits.length === 0 && !scripty) return null;

    const allHits = [...hits, ...weakHits];
    return {
      ruleId: 'malware-indicators',
      ruleName: 'Malware Indicators',
      category: ThreatCategory.MALWARE,
      severity:
        allHits.length >= 2 || scripty ? Severity.CRITICAL : Severity.HIGH,
      confidence: 0.7,
      evidence: `Malware-related terms/files: ${[...allHits, scripty ? 'suspicious executables' : ''].filter(Boolean).join(', ')}`,
      explanation:
        'Repository shows malware-related terminology or suspicious executable patterns.',
      riskContribution: 28 + Math.min(12, allHits.length * 4),
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

/** New GitHub account, deliberately conservative: zero followers AND at most one public repo. */
const EMPTY_PROFILE_MAX_FOLLOWERS = 0;
const EMPTY_PROFILE_MAX_REPOS = 1;
/** Matches the repo-age window lowReputationRule already uses for "new repo". */
const NEW_ACCOUNT_MAX_AGE_DAYS = 30;

/**
 * lowReputationRule above looks at the REPO's own stars/age - this looks at
 * the OWNER's GitHub account instead. A repo's own metadata is entirely
 * within the operator's control (easy to fake with bought stars, easy to
 * let a repo sit quietly for a while before using it), but a genuinely
 * established developer identity - an account with real age, followers, and
 * other public work - is much harder to fabricate cheaply. This is what
 * catches the classic throwaway-account shape: a brand-new account, with
 * essentially no public footprint, whose only real activity is this one
 * impersonation/phishing repo. Only evaluated when ownerAccountCreatedAt/
 * ownerFollowers/ownerPublicRepos were actually fetched (see
 * fetchRepositoryContext) - deliberately conservative thresholds (0
 * followers, <=1 repo) since this is a NEW signal with no track record yet;
 * a real solo developer with a handful of followers should never trip this.
 */
export const suspiciousOwnerAccountRule: DetectionRule = {
  id: 'suspicious-owner-account',
  name: 'Newly Created / Low-Reputation Account',
  evaluate(ctx): DetectionResult | null {
    const brand = brandPresent(ctx, textBlob(ctx));
    if (!brand) return null;
    if (
      ctx.ownerAccountCreatedAt == null &&
      ctx.ownerFollowers == null &&
      ctx.ownerPublicRepos == null
    ) {
      return null;
    }

    const ageDays = ctx.ownerAccountCreatedAt
      ? (Date.now() - ctx.ownerAccountCreatedAt.getTime()) /
        (1000 * 60 * 60 * 24)
      : undefined;
    const newAccount = ageDays !== undefined && ageDays <= NEW_ACCOUNT_MAX_AGE_DAYS;
    const emptyProfile =
      (ctx.ownerFollowers ?? Infinity) <= EMPTY_PROFILE_MAX_FOLLOWERS &&
      (ctx.ownerPublicRepos ?? Infinity) <= EMPTY_PROFILE_MAX_REPOS;

    if (!newAccount && !emptyProfile) return null;

    const bothSignals = newAccount && emptyProfile;
    const ageDetail =
      ageDays !== undefined ? `account age ~${Math.round(ageDays)}d, ` : '';
    return {
      ruleId: 'suspicious-owner-account',
      ruleName: 'Newly Created / Low-Reputation Account',
      category: ThreatCategory.SUSPICIOUS_REPO,
      severity: bothSignals ? Severity.MEDIUM : Severity.LOW,
      confidence: bothSignals ? 0.7 : 0.5,
      evidence: `Owner "${ctx.owner}": ${ageDetail}${ctx.ownerFollowers ?? 0} followers, ${ctx.ownerPublicRepos ?? 0} public repos`,
      explanation:
        'The GitHub account behind this repository is newly created and/or has almost no public footprint (followers, other repos) - a common shape for a throwaway account built specifically to host an impersonation/phishing repo, as opposed to an established developer identity.',
      riskContribution: bothSignals ? 14 : 8,
    };
  },
};

/**
 * The individual signals below (brand match, phishing/APK terms, low
 * reputation, new repo) already each fire their own rule and contribute
 * their own points - this rule is not meant to pile more points on top of
 * that. Its job is to name the *specific combination* explicitly: a
 * brand-new, zero-activity repo combining a monitored brand with an
 * intent signal is the recognizable shape of a disposable, throwaway
 * attack repo, not a coincidence of several weak signals. That's a
 * distinct, higher-confidence claim from "several unrelated things
 * happened to match" - worth its own labeled line in the risk breakdown
 * so an analyst sees *why* this one is different, not just a bigger
 * number.
 */
export const disposablePhishingRepoRule: DetectionRule = {
  id: 'disposable-phishing-repo',
  name: 'Disposable Phishing Repo Pattern',
  evaluate(ctx): DetectionResult | null {
    const blob = textBlob(ctx);
    const brand = brandPresent(ctx, blob);
    if (!brand) return null;

    // Zero stars/forks and not a fork of something legitimate - an original,
    // completely unused repo. A fork of a real project (even a new one)
    // doesn't fit this pattern; forks are excluded on purpose.
    const isDisposableRepo = ctx.stars === 0 && ctx.forks === 0 && !ctx.isFork;
    if (!isDisposableRepo) return null;

    const ageDays = ctx.githubCreatedAt
      ? (Date.now() - ctx.githubCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
      : 999;
    // Tighter than lowReputationRule's 30-day window - this rule is meant to
    // catch the "built and abandoned within days" shape specifically.
    if (ageDays > 14) return null;

    const phishingHits = PHISHING_TERMS.filter((t) => blob.includes(t)).length;
    const hasApkSignal =
      APK_HINTS.some((h) => blob.includes(h)) ||
      ctx.filePaths.some((p) => p.toLowerCase().endsWith('.apk'));
    const hasImpersonationTerm = SUSPICIOUS_KEYWORDS.some((k) =>
      blob.includes(k.toLowerCase()),
    );
    const intentSignalCount = [
      phishingHits > 0,
      hasApkSignal,
      hasImpersonationTerm,
    ].filter(Boolean).length;
    if (intentSignalCount === 0) return null;

    return {
      ruleId: 'disposable-phishing-repo',
      ruleName: 'Disposable Phishing Repo Pattern',
      category: ThreatCategory.PHISHING,
      severity: Severity.HIGH,
      confidence: Math.min(0.95, 0.75 + intentSignalCount * 0.07),
      evidence: `Brand "${brand}" + ${intentSignalCount} intent signal(s) (phishing terms, APK artifacts, or impersonation keywords) in a ${Math.round(ageDays)}-day-old repo with zero stars, zero forks, not a fork itself`,
      explanation:
        'Brand-new, completely unused repository combining a monitored brand with phishing/malware-adjacent signals matches the recognizable shape of a disposable attack repo, not a coincidental partial match.',
      riskContribution: 15,
    };
  },
};

export const obfuscationRule: DetectionRule = {
  id: 'obfuscated-commands',
  name: 'Obfuscated / Encoded Commands',
  evaluate(ctx): DetectionResult | null {
    const patterns = [
      /powershell\s+-enc\s+/i,
      /eval\s*\(\s*atob\s*\(/i,
      // Decode-then-execute ("curl ... | base64 -d | bash") is the actual
      // malicious shape; bare "base64 -d" alone is an extremely common,
      // completely benign pattern for decoding a CI/CD secret into a file.
      /base64\s+-d\s*\|\s*(?:sh|bash|zsh|python3?|perl|ruby|node|powershell)\b/i,
      // The PowerShell array-syntax form specifically, not bare
      // "FromBase64String" - that's a standard, ubiquitous .NET API call
      // (Convert.FromBase64String) used constantly in ordinary, benign code
      // (decoding a JWT, a config value, an image) with zero malicious
      // specificity on its own.
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

// No GitHub quota cost here (just checking content already fetched), so
// this can afford to be far more generous than the discovery-side query
// cap - raised to comfortably cover a large curated keyword list without
// silently dropping most of the matches a repo actually has.
const MAX_CUSTOM_KEYWORD_MATCHES = 20;

const LOCATION_LABELS: Record<BrandMatchLocation, string> = {
  owner: 'the repo owner',
  repo_name: 'the repository name',
  description: 'the repo description',
  topics: 'the repo topics',
  file_path: 'a file path',
  readme: 'the README',
  file_content: 'file content',
  commit_message: 'a commit message',
  commit_author: 'a commit author name',
};

/**
 * The generic SUSPICIOUS_KEYWORDS list above is necessarily brand-agnostic,
 * so a perfectly normal word for one brand ("trading" for a trading
 * platform) reads as suspicious for another. This rule checks a brand's own
 * user-curated "Search keywords" (set on the Companies/Brand page) instead -
 * terms the analyst themselves picked as worth watching for *this specific
 * brand* - and reports exactly which keyword hit and where, the same way
 * brand name/alias matches already do (see findKeywordMatches).
 */
export const customKeywordMatchRule: DetectionRule = {
  id: 'custom-keyword-match',
  name: 'Custom Keyword Match',
  evaluate(ctx): DetectionResult[] | null {
    const brand = ctx.matchedBrandName;
    if (!brand) return null;
    // A keyword that's literally the brand's own name/alias ("zerodha" as
    // both keywords[0] and the brand name itself) isn't new information -
    // brandImpersonationRule/the brand-match evidence already covers "this
    // repo mentions the brand". Reporting it again here as its own "Custom
    // Keyword Match" would just restate the same fact under a second rule
    // and double-count it in the risk score.
    const brandIdentity = new Set(
      [brand, ...(ctx.matchedBrandAliases || [])].map((a) => a.toLowerCase()),
    );
    const keywords = dedupeKeywordsCaseInsensitive(
      ctx.matchedBrandKeywords || [],
    ).filter((k) => !brandIdentity.has(k.toLowerCase()));
    if (keywords.length === 0) return null;

    const matches = findKeywordMatches(
      keywords,
      {
        repoName: ctx.fullName,
        description: ctx.description,
        topics: ctx.topics,
        filePaths: ctx.filePaths,
        readmeText: ctx.readmeText,
        fileTexts: ctx.smallFileTexts,
        commitMessages: ctx.commitMessages,
        commitAuthors: ctx.commitAuthors,
        // Full-repo depth: a keyword hit anywhere in the tree, not just the
        // maxFiles-capped sample above. findKeywordMatches/findBrandMatch
        // already filters this to hits matching the ONE keyword being
        // checked in this call, so keywordFileMatches being grepped for
        // every brand's keywords up front (before this brand ever won the
        // match) never leaks another brand's keyword hit in here.
        fullRepoTextMatches: ctx.keywordFileMatches,
      },
      MAX_CUSTOM_KEYWORD_MATCHES,
    );
    if (matches.length === 0) return null;

    return matches.map(({ keyword, evidence }) => {
      // repo_name/description/topics/file_path are the repo author's own
      // deliberate words, not noisy incidental mentions - same strong/weak
      // split findBrandMatch's own ranking uses (see STRONG_LOCATIONS).
      const isStrongLocation = [
        'repo_name',
        'description',
        'topics',
        'file_path',
      ].includes(evidence.location);
      const isExact = evidence.type === 'exact';
      const severity =
        isExact && isStrongLocation ? Severity.MEDIUM : Severity.LOW;
      const confidence = isExact ? (isStrongLocation ? 0.75 : 0.6) : 0.5;
      const riskContribution = isExact ? (isStrongLocation ? 18 : 12) : 8;
      const locationLabel = LOCATION_LABELS[evidence.location];
      const fileSuffix = evidence.filePath
        ? ` (${evidence.filePath}${evidence.lineNumber ? `:${evidence.lineNumber}` : ''})`
        : '';

      return {
        ruleId: 'custom-keyword-match',
        ruleName: 'Custom Keyword Match',
        category: ThreatCategory.CUSTOM_KEYWORD_MATCH,
        severity,
        confidence,
        evidence: `Keyword "${keyword}" found in ${locationLabel}${fileSuffix}: "${evidence.matchedText}"`,
        explanation: `Repository references monitored brand "${brand}" and contains one of this brand's own curated risk keywords ("${keyword}"), found in ${locationLabel}.`,
        riskContribution,
        file: evidence.filePath,
        lineNumber: evidence.lineNumber,
        matchedText: evidence.matchedText,
      };
    });
  },
};

const MAX_DESTINATION_DETECTIONS = 5;

/**
 * The sharpest distinction there is between "this looks like the brand's
 * login page" and "this is actually trying to steal something": where does
 * a submitted form or an API call in this repo's own code actually send
 * data. A brand-impersonating repo whose login form posts to some unrelated
 * domain isn't a coincidence - that's the repo's own code stating who
 * actually receives what a victim types in. See extractDataDestinations for
 * exactly what does and doesn't count as a "destination" here.
 */
export const suspiciousDestinationRule: DetectionRule = {
  id: 'suspicious-destination',
  name: 'Suspicious Data Destination',
  evaluate(ctx): DetectionResult[] | null {
    const brand = ctx.matchedBrandName;
    if (!brand) return null;

    const destinations = extractDataDestinations(ctx).slice(
      0,
      MAX_DESTINATION_DETECTIONS,
    );
    if (destinations.length === 0) return null;

    return destinations.map((d) => ({
      ruleId: 'suspicious-destination',
      ruleName: 'Suspicious Data Destination',
      category: ThreatCategory.SUSPICIOUS_DESTINATION,
      severity: Severity.HIGH,
      confidence: 0.7,
      evidence: `Repository references monitored brand "${brand}" but sends data to "${d.hostname}" (found in ${d.source}) - not the brand's own known domain.`,
      explanation:
        "A form submission or API call target that is neither this brand's own known domain nor a well-known benign service - where the code actually sends captured data, not just what the page looks like.",
      riskContribution: 25,
      file: d.source,
      matchedText: d.url,
    }));
  },
};

/**
 * A weaker, supportive signal on its own - a deploy config just means "built
 * to actually run somewhere", not proof of anything. Only worth surfacing
 * alongside a brand match, same reasoning as every other impersonation-only
 * rule here: a deploy config on a repo with no brand connection at all is
 * meaningless noise.
 */
export const deploymentSignalRule: DetectionRule = {
  id: 'deployment-signal',
  name: 'Deploy Configuration Present',
  evaluate(ctx): DetectionResult | null {
    const brand = ctx.matchedBrandName;
    if (!brand) return null;

    const configs = findDeployConfigFiles(ctx.filePaths);
    if (configs.length === 0) return null;

    return {
      ruleId: 'deployment-signal',
      ruleName: 'Deploy Configuration Present',
      category: ThreatCategory.SUSPICIOUS_DESTINATION,
      severity: Severity.LOW,
      confidence: 0.5,
      evidence: `Repository references monitored brand "${brand}" and includes deploy configuration (${configs.join(', ')}) - built to actually run somewhere, not just a static code sample.`,
      explanation:
        'Presence of hosting/deploy configuration suggests this is meant to be actively deployed, not just a coding exercise - weak on its own, worth more alongside other signals.',
      riskContribution: 8,
    };
  },
};
