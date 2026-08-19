const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('accessToken');
}

// Cross-request caches keyed to the current identity. Anything cached here
// must be invalidated in setToken() below, since that's the single place
// login/register/logout all funnel through — otherwise a client-side route
// change (no full page reload) after switching accounts can keep serving
// data fetched under the previous identity.
let workspacesCache: Promise<unknown> | null = null;
export function getWorkspacesCache<T>(): Promise<T> | null {
  return workspacesCache as Promise<T> | null;
}
export function setWorkspacesCache<T>(promise: Promise<T> | null) {
  workspacesCache = promise;
}

export function setToken(token: string | null) {
  if (typeof window === 'undefined') return;
  workspacesCache = null;
  if (token) localStorage.setItem('accessToken', token);
  else {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('workspaceId');
  }
}

export function getWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('workspaceId');
}

export function setWorkspaceId(id: string | null) {
  if (typeof window === 'undefined') return;
  if (id) localStorage.setItem('workspaceId', id);
  else localStorage.removeItem('workspaceId');
}

export async function api<T>(
  path: string,
  options: RequestInit & { auth?: boolean; workspace?: boolean } = {},
): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');

  if (options.auth !== false) {
    const token = getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  // Workspace-scoped routes need the verified membership header.
  // Workspace management routes under /workspaces omit it unless forced.
  const needsWorkspace =
    options.workspace === true ||
    (options.workspace !== false &&
      options.auth !== false &&
      !path.startsWith('/workspaces') &&
      !path.startsWith('/auth/') &&
      !path.startsWith('/health'));

  if (needsWorkspace) {
    const workspaceId = getWorkspaceId();
    if (workspaceId) headers.set('X-Workspace-Id', workspaceId);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message =
      (data && (data.message as string | string[])) ||
      res.statusText ||
      'Request failed';
    throw new ApiError(
      Array.isArray(message) ? message.join(', ') : String(message),
      res.status,
      data,
    );
  }

  return data as T;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type WorkspaceRole = 'owner';

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface AuthResponse {
  accessToken: string;
  tokenType: string;
  user: { id: string; email: string; name: string };
  defaultWorkspaceId?: string;
}

export interface WorkspaceSummary {
  _id: string;
  name: string;
  slug: string;
  role?: WorkspaceRole;
  isDefault?: boolean;
}

export interface DashboardSummary {
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  reposScanned: number;
  unreadAlerts: number;
  findingsBySeverity: Array<{ severity: string; count: number }>;
  findingsByCategory: Array<{ category: string; count: number }>;
  findingsOverTime: Array<{ date: string; count: number }>;
  recentCritical: Array<Finding>;
  githubRateLimit?: GitHubRateLimitStatus | null;
}

export interface GitHubRateLimitStatus {
  configured: boolean;
  primary: Record<
    string,
    {
      resource: string;
      limit: number;
      remaining: number;
      used: number;
      resetAt: number;
      updatedAt: number;
    } | null
  >;
  pause: {
    paused: boolean;
    pausedUntil: number | null;
    reason: string | null;
    resource: string | null;
  };
  secondaryRetryAfterUntil: number | null;
  workspace: {
    workspaceId: string;
    day: string;
    used: number;
    limit: number;
    remaining: number;
    inFlight: number;
    maxConcurrency: number;
  } | null;
  pausedScanCount: number;
  warnings: string[];
  metrics: {
    requestsTotal: number;
    retriesTotal: number;
    rateLimitHits: number;
    budgetRejects: number;
    secondaryHits: number;
  };
  thresholds: {
    lowRemaining: number;
    pauseRemaining: number;
    workspaceDailyBudget: number;
    workspaceMaxConcurrency: number;
    globalMaxConcurrency: number;
  };
}

export type ThreatClass = 'credential_exposure' | 'malicious_intent' | 'other';

export interface Finding {
  _id: string;
  summary: string;
  severity: Severity;
  riskScore: number;
  categories: string[];
  /** Derived at read-time from `categories` - not stored. */
  threatClass?: ThreatClass[];
  /** Distinct curated keywords matched (count of this finding's own 'custom-keyword-match' detections). */
  keywordMatchCount?: number;
  brandName?: string;
  /** Why brandName is what it is - a verified account, an exact text match, or a fuzzy one. */
  brandMatchEvidence?: BrandMatchEvidence;
  /** 'internal' = found in the brand's own repo (rotate the credential). 'external' = found in someone else's repo (report/takedown). */
  origin?: 'internal' | 'external';
  status?: 'open' | 'acknowledged' | 'resolved' | 'false_positive';
  lastChangeType?: 'new' | 'unchanged' | 'reopened' | 'resolved';
  triageNote?: string;
  triagedAt?: string;
  reopenedAt?: string;
  resolvedAt?: string;
  isDemo?: boolean;
  createdAt?: string;
  lastSeenAt?: string;
  riskBreakdown?: Array<{ factor: string; points: number; detail: string }>;
  repositoryId?: Repository | string;
  detections?: Detection[];
  /** Other GitHub accounts sharing an identical contact/wallet fingerprint with this repo. */
  linkedIdentities?: LinkedIdentity[];
  /** This repo's own contributor roster, each annotated with other repos in this workspace they've also contributed to. */
  contributors?: RepoContributor[];
}

export interface BrandMatchEvidence {
  type: 'trusted_owner' | 'exact' | 'fuzzy';
  location:
    | 'owner'
    | 'repo_name'
    | 'description'
    | 'topics'
    | 'file_path'
    | 'readme'
    | 'file_content'
    | 'commit_message'
    | 'commit_author';
  matchedAlias: string;
  matchedText: string;
  /** Which file the match was found in - set only when location is 'file_content'. */
  filePath?: string;
  /** 1-indexed line the match was found on - set only when location is 'readme' or 'file_content'. */
  lineNumber?: number;
}

export interface LinkedIdentity {
  kind: string;
  value: string;
  owner: string;
  fullName: string;
  repositoryId: string;
}

export interface RepoContributor {
  login: string;
  avatarUrl?: string;
  /** Commit count on this one repo. */
  contributions: number;
  /** Every OTHER repo in this workspace the same login has also contributed to. */
  otherRepositories: Array<{ repositoryId: string; fullName: string }>;
}

/** GitHub's own "Deployments" feature - a live environment URL, not GitHub Pages. */
export interface RepositoryDeployment {
  environment: string;
  url: string;
  state: string;
  updatedAt?: string;
}

export interface ContributorRepoSummary {
  repositoryId: string;
  fullName: string;
  owner: string;
  contributions: number;
  /** The company (monitored brand) this repo was discovered for, if any. */
  company?: string;
}

/** One GitHub contributor seen across this workspace's deep-analyzed repos - see the Contributors page. */
export interface ContributorSummary {
  login: string;
  avatarUrl?: string;
  totalRepositories: number;
  companies: string[];
  repositories: ContributorRepoSummary[];
}

export interface Repository {
  _id: string;
  fullName: string;
  url: string;
  owner: string;
  name?: string;
  description: string;
  language?: string;
  stars: number;
  forks: number;
  isFork?: boolean;
  topics: string[];
  githubCreatedAt?: string;
  githubUpdatedAt?: string;
  githubPushedAt?: string;
  lastScannedAt?: string;
  lastProcessingFailed?: boolean;
  /** True until a real content-analysis pass has run on it - see "Analyze discovered repos". */
  pendingAnalysis?: boolean;
  isDemo?: boolean;
  /** When THIS workspace's own scans first found it - not GitHub's own created_at. Drives the /repositories page's default sort order. */
  createdAt?: string;
  /** When THIS workspace's own scans last touched it (a re-discovery, or an analysis pass). */
  updatedAt?: string;
  /** Which monitored brand this repo was found for. */
  matchedBrand?: string;
  /** True once a real Finding exists (content was actually analyzed) - false means this is still just a search-level hit, not yet confirmed. */
  matchConfirmed?: boolean;
  /**
   * Where the match is: owner, repo_name, description, topics, file_path,
   * readme, file_content, commit_message, commit_author. Set from the
   * Finding's own evidence once matchConfirmed - but also set, best-effort,
   * for a still-unconfirmed repo whose discovering scan could tell from its
   * search response alone (repo_name/description/topics client-side, or
   * file_content from GitHub code search's own per-file path) - see
   * ScansService.attachMatchInfo. Only genuinely absent for an older
   * discovery or a full brand sweep with no single keyword to check.
   */
  matchLocation?: string;
  /** The literal text that matched. */
  matchedText?: string;
  /** Set only when matchLocation is 'file_content' or 'readme'. */
  matchFilePath?: string;
  matchLineNumber?: number;
  /** The keyword the discovering scan was scoped to - set whenever the repo isn't matchConfirmed yet, regardless of whether matchLocation was also determined. */
  matchKeyword?: string;
  /**
   * Every OTHER monitored company this repo also matched, besides
   * matchedBrand (whichever one's scan found it first) - e.g. a
   * broker-comparison app mentioning several brokers by name. Without
   * this a repo would silently look like it only belongs to matchedBrand,
   * even when it's just as relevant to these too. See
   * Repository.additionalBrandMatches.
   */
  additionalBrands?: { name: string; keyword?: string }[];
  /** Most recent live deployment found via GitHub's Deployments API - null/absent means none exists, or the repo hasn't been analyzed yet. */
  deployment?: RepositoryDeployment | null;
}

/** One branch of a known repository - see GET /scans/repositories/:id/branches. GitHub's search index only ever covers the default branch, so this is the only way to even discover a side branch exists. */
export interface RepositoryBranch {
  name: string;
  sha: string;
  protected: boolean;
  isDefault: boolean;
}

/** One repo where a rescan just turned up a new or previously-resolved-but-back finding - see ScansService.getRecentChanges. */
export interface RecentFindingChange {
  findingId: string;
  repository: { _id: string; fullName: string; url: string };
  brandName?: string;
  severity: string;
  summary: string;
  changeType: 'new' | 'reopened';
  lastSeenAt: string;
}

export interface RecentRepositoryChanges {
  /** Repos pushed to on GitHub recently, sorted newest-pushed first - regardless of whether any scan has touched them since. */
  recentPushes: Repository[];
  /** Repos where OUR analysis just found something new/reopened, sorted most-recent first - independent of how much code actually moved. */
  recentFindingChanges: RecentFindingChange[];
}

export interface Detection {
  _id: string;
  ruleId: string;
  ruleName: string;
  category: string;
  severity: Severity;
  confidence: number;
  evidence: string;
  explanation: string;
  riskContribution: number;
  /** Only set for file-content-based rules (secrets, obfuscated commands) - metadata-based rules (impersonation, phishing, etc.) have no single file/line. */
  file?: string;
  lineNumber?: number;
  matchedText?: string;
  /** Result of a manual, analyst-triggered live check of whether this exposed secret is still an active credential. */
  verification?: CredentialVerification;
}

export interface CredentialVerification {
  status: 'active' | 'invalid' | 'unsupported' | 'error';
  detail: string;
  checkedAt: string;
}

export interface ScanJob {
  _id: string;
  type: string;
  status: string;
  mode?: 'incremental' | 'full' | 'failed_only' | 'analyze_pending';
  forceFullScan?: boolean;
  rulesetVersion?: string;
  reposFound: number;
  reposAnalyzed: number;
  reposDiscovered?: number;
  reposProcessed?: number;
  reposFailed?: number;
  reposTotal?: number;
  reposSkipped?: number;
  reposRescanned?: number;
  reposResumed?: number;
  /** Repos this scan discovered and saved but deliberately did not analyze (discoveryOnly mode). */
  reposPendingAnalysis?: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsNew?: number;
  findingsUnchanged?: number;
  findingsReopened?: number;
  findingsResolved?: number;
  /** Repos processed in this scan whose finding came out HIGH or CRITICAL severity - "how many are actually a real threat". */
  findingsHighRisk?: number;
  message: string;
  error: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  queriesUsed?: string[];
  cancelRequested?: boolean;
  progressPercent?: number;
  progressPhase?: string;
  progressMessage?: string;
  progressSeq?: number;
  maxRepos?: number;
  createdFrom?: string;
  createdTo?: string;
  /** Internal audit: enumerates the scoped brand's own trustedGithubOwners repos for exposed secrets, instead of searching for brand mentions. */
  internalAudit?: boolean;
  /** Monitored company this scan was scoped to, if any (omitted for a workspace-wide sweep across every enabled brand). */
  scopeBrandId?: string;
  /** Exactly which of that company's own keywords this scan was scoped to, if any - see the per-keyword toggle / sequential scheduler. */
  scopeKeyword?: string;
  /** Raw custom GitHub query this scan was scoped to instead of generated brand/keyword queries, if any. */
  scopeQuery?: string;
  /** Discovers and saves candidate repos without running content analysis on any of them - see mode=analyze_pending to analyze them later. */
  discoveryOnly?: boolean;
  /** Resumed each search query from this workspace's last discovery cursor instead of starting at page 1. */
  continueDiscovery?: boolean;
  checkpoint?: {
    /** queryIndex -> the page this scan actually started that query on (1 = fresh, >1 = resumed from a prior scan's cursor). Pairs by array position with queriesUsed. */
    searchStartPages?: Record<string, number>;
  };
}

export interface GithubTokenStatus {
  configured: boolean;
  last4?: string;
  updatedAt?: string;
}

export interface Brand {
  _id: string;
  name: string;
  description?: string;
  aliases: string[];
  keywords: string[];
  /** This brand's own real GitHub org/user accounts, if known - scanned unconditionally regardless of keyword matches. */
  trustedGithubOwners: string[];
  enabled: boolean;
}

/** One user-queued keyword's own turn: which company it belongs to, which keyword, and how long its slot runs for (ms). A queue can mix several companies. */
export interface KeywordRotationSlot {
  brandId: string;
  keyword: string;
  durationMs: number;
  /** True once this one keyword is individually paused - the rest of the queue keeps running. See the per-row pause/resume toggle in KeywordScheduleQueue. */
  paused?: boolean;
  /** Which GitHub search kind(s) this keyword's turn runs - 'both' (default), 'repositories' only, or 'code' only. See the per-row search-scope control in KeywordScheduleQueue. */
  searchScope?: 'both' | 'repositories' | 'code';
  /** True (default) resumes this keyword's queries from its own discovery cursor each turn instead of restarting at page 1 - see the per-row "Start from beginning"/"Resume from last" control in KeywordScheduleQueue. */
  continueDiscovery?: boolean;
}

/** The workspace's sequential keyword scheduler state - see KeywordScheduleQueue. One shared queue per workspace, not per company. */
export interface KeywordRotationStatus {
  _id: string;
  workspaceId: string;
  enabled: boolean;
  /** The user-built, user-ordered queue this rotation runs - exactly this sequence, each with its own company and duration. */
  slots: KeywordRotationSlot[];
  currentIndex: number;
  currentScanJobId?: string;
  currentBrandId?: string;
  currentKeyword?: string;
  slotStartedAt?: string;
  slotEndsAt?: string;
  dateFilterMode: 'any' | 'dated';
  createdFrom?: string;
  createdTo?: string;
  pushedFrom?: string;
  pushedTo?: string;
  cyclesCompleted: number;
  lastError: string;
  /** Time left in the current slot, ms - undefined when disabled or no slot is active. */
  remainingMs?: number;
  /** How many times the current slot has already been extended because the keyword was stuck waiting on GitHub quota instead of actually working. */
  currentSlotExtensions: number;
  /** True right now if the current keyword's scan is paused waiting on GitHub quota - explains why remainingMs might jump back up instead of reaching zero and handing off. */
  waitingOnQuota: boolean;
}

export interface Keyword {
  _id: string;
  keyword: string;
  category: string;
  priority: number;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubSearchResult {
  total_count: number;
  incomplete_results: boolean;
  /** Repos hidden because this workspace has already seen them (unless includeSeen was set). */
  hiddenSeenCount?: number;
  items: Array<{
    id: number;
    full_name?: string;
    name?: string;
    html_url: string;
    description?: string | null;
    stargazers_count?: number;
    language?: string | null;
    owner?: { login: string };
    path?: string;
    repository?: { full_name: string; html_url: string };
  }>;
}

export interface RulePrecisionStat {
  ruleId: string;
  ruleName: string;
  totalFindings: number;
  falsePositiveCount: number;
  falsePositiveRate: number;
}

export interface AlertItem {
  _id: string;
  title: string;
  message: string;
  severity: Severity;
  read: boolean;
  createdAt?: string;
  findingId?: string | Finding;
}

export function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'var(--critical)';
    case 'high':
      return 'var(--high)';
    case 'medium':
      return 'var(--medium)';
    default:
      return 'var(--low)';
  }
}
