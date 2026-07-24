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
}

export enum ScanJobType {
  MANUAL = 'manual',
}

/** How a manual (or scheduled) scan selects repositories for content analysis. */
export enum ScanMode {
  INCREMENTAL = 'incremental',
  FULL = 'full',
  FAILED_ONLY = 'failed_only',
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
  { name: 'Groww', aliases: ['groww'], keywords: ['groww'] },
  { name: 'Upstox', aliases: ['upstox'], keywords: ['upstox'] },
  {
    name: 'INDmoney',
    aliases: ['indmoney', 'ind money'],
    keywords: ['indmoney'],
  },
  { name: 'PhonePe', aliases: ['phonepe', 'phone pe'], keywords: ['phonepe'] },
  {
    name: 'Google Pay',
    aliases: ['gpay', 'googlepay'],
    keywords: ['google pay', 'gpay'],
  },
  { name: 'Paytm', aliases: ['paytm'], keywords: ['paytm'] },
  { name: 'BharatPe', aliases: ['bharatpe'], keywords: ['bharatpe'] },
  { name: 'Google', aliases: ['google'], keywords: ['google'] },
  {
    name: 'Microsoft',
    aliases: ['microsoft', 'msft'],
    keywords: ['microsoft'],
  },
  {
    name: 'AWS',
    aliases: ['amazon web services', 'amazonaws'],
    keywords: ['aws'],
  },
  { name: 'Stripe', aliases: ['stripe'], keywords: ['stripe'] },
  { name: 'OpenAI', aliases: ['openai', 'chatgpt'], keywords: ['openai'] },
] as const;

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
