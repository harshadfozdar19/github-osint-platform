export enum Severity {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export enum ThreatCategory {
  EXPOSED_SECRET = 'exposed_secret',
  BRAND_IMPERSONATION = 'brand_impersonation',
  PHISHING = 'phishing',
  FAKE_APK = 'fake_apk',
  MALWARE = 'malware',
  SUSPICIOUS_REPO = 'suspicious_repo',
  /** A secret value found here matches, byte-for-byte, one previously found in the brand's own reference repos - not just "a secret of the same shape". */
  CREDENTIAL_REUSE = 'credential_reuse',
  /** Text or a whole file found here matches the brand's own reference content verbatim - copied wording or a byte-identical file, not just a similar one. */
  CONTENT_REUSE = 'content_reuse',
  /** An exact hit on one of THIS brand's own user-curated "Search keywords" (set on the Companies/Brand page) - not the generic, brand-agnostic SUSPICIOUS_KEYWORDS list. */
  CUSTOM_KEYWORD_MATCH = 'custom_keyword_match',
  /** A brand-matched repo whose code submits/sends data (a login form, an API call) to a domain that is neither the brand's own nor a well-known benign service - where captured data actually goes, not just what the page looks like. */
  SUSPICIOUS_DESTINATION = 'suspicious_destination',
  /** Not just "this code could be a phishing site" - independently confirmed to be actually live and reachable right now (a working GitHub Pages deployment, or a discovered destination that responds). */
  CONFIRMED_LIVE = 'confirmed_live',
}

export enum ScanJobType {
  MANUAL = 'manual',
}

/** How a manual (or scheduled) scan selects repositories for content analysis. */
export enum ScanMode {
  INCREMENTAL = 'incremental',
  FULL = 'full',
  FAILED_ONLY = 'failed_only',
  /** Skips search entirely and runs content analysis on every repo a prior discoveryOnly scan found but deferred - see ScanJob.discoveryOnly. */
  ANALYZE_PENDING = 'analyze_pending',
  /**
   * On-demand: clones and scans exactly ONE already-known repository's ONE
   * specific non-default branch, deliberately outside the normal
   * search/incremental machinery - GitHub's search index only ever covers a
   * repo's default branch, so this is the only way to check a side branch a
   * user suspects is hiding something the default branch isn't. Requires
   * scopeRepositoryId and scopeBranch. Never touches Repository's own
   * default-branch bookkeeping (lastProcessedCommitSha/defaultBranch/
   * lastScannedAt) - see BranchAnalysisProcessor.
   */
  BRANCH_ANALYSIS = 'branch_analysis',
}

export enum ScanJobStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  PARTIALLY_COMPLETED = 'partially_completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  SKIPPED = 'skipped',
}

/**
 * Once a scan reaches one of these, it never legitimately goes back to
 * QUEUED/RUNNING - see ScanProgressService.buildFromJobDoc, which relies on
 * this to stop a straggling worker's progress event (still hardcoding
 * status: RUNNING because it doesn't know it's been cancelled yet) from
 * overwriting an already-terminal scan's displayed status.
 */
export const TERMINAL_SCAN_STATUSES: ScanJobStatus[] = [
  ScanJobStatus.COMPLETED,
  ScanJobStatus.PARTIALLY_COMPLETED,
  ScanJobStatus.FAILED,
  ScanJobStatus.CANCELLED,
];

/** Outcome of a finding relative to the previous successful scan of that repo. */
export enum FindingChangeType {
  NEW = 'new',
  UNCHANGED = 'unchanged',
  REOPENED = 'reopened',
  RESOLVED = 'resolved',
}

export enum ScanCheckpointStage {
  QUEUED = 'queued',
  ORCHESTRATED = 'orchestrated',
  SEARCH = 'search',
  ANALYSIS = 'analysis',
  DETECTION = 'detection',
  FINALIZED = 'finalized',
}

export enum FindingStatus {
  OPEN = 'open',
  ACKNOWLEDGED = 'acknowledged',
  RESOLVED = 'resolved',
  FALSE_POSITIVE = 'false_positive',
}

export enum WorkspaceRole {
  OWNER = 'owner',
}

export enum WorkspaceMemberStatus {
  ACTIVE = 'active',
}

export const WORKSPACE_HEADER = 'x-workspace-id';

export interface RiskBreakdownItem {
  factor: string;
  points: number;
  detail: string;
}

export interface DetectionResult {
  ruleId: string;
  ruleName: string;
  category: ThreatCategory;
  severity: Severity;
  confidence: number;
  evidence: string;
  explanation: string;
  riskContribution: number;
  file?: string;
  lineNumber?: number;
  matchedText?: string;
}

export const MONITORED_BRANDS = [
  { name: 'FYND', aliases: ['fynd'], keywords: ['fynd'] },
  {
    name: 'Zerodha',
    aliases: ['zerodha', 'kite'],
    keywords: ['zerodha', 'kite trading'],
  },
  {
    name: 'Angel One',
    aliases: ['angelone', 'angel broking'],
    keywords: ['angel one', 'angelone'],
  },
  {
    name: 'INDmoney',
    aliases: ['indmoney', 'ind money'],
    keywords: ['indmoney'],
  },
] as const;

/**
 * Show up constantly in completely unrelated, legitimate repos - a
 * customer-"support" bot, a game "mod", a well-known open-source project's
 * "clone" - so one of these next to a brand mention is weak evidence on its
 * own. See WEAK_SUSPICIOUS_KEYWORDS usage in threat.rules.ts: a weak hit
 * only counts toward impersonation when it co-occurs with another hit.
 */
export const WEAK_SUSPICIOUS_KEYWORDS = ['support', 'mod', 'clone'] as const;

export const SUSPICIOUS_KEYWORDS = [
  'login',
  'verification',
  'wallet',
  'payment',
  'kyc',
  'trading',
  'support',
  'apk',
  'mod',
  'cracked',
  'phishing',
  'clone',
  'bypass',
  'free money',
  'gift card',
  'otp',
  '2fa bypass',
] as const;

export function severityFromScore(score: number): Severity {
  if (score >= 85) return Severity.CRITICAL;
  if (score >= 65) return Severity.HIGH;
  if (score >= 40) return Severity.MEDIUM;
  return Severity.LOW;
}
