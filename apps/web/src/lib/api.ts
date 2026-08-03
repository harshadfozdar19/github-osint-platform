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

export interface Finding {
  _id: string;
  summary: string;
  severity: Severity;
  riskScore: number;
  categories: string[];
  brandName?: string;
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
}

export interface Repository {
  _id: string;
  fullName: string;
  url: string;
  owner: string;
  description: string;
  stars: number;
  forks: number;
  topics: string[];
  githubCreatedAt?: string;
  githubPushedAt?: string;
  lastScannedAt?: string;
  isDemo?: boolean;
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
}

export interface ScanJob {
  _id: string;
  type: string;
  status: string;
  mode?: 'incremental' | 'full' | 'failed_only';
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
  findingsCreated: number;
  findingsUpdated: number;
  findingsNew?: number;
  findingsUnchanged?: number;
  findingsReopened?: number;
  findingsResolved?: number;
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
  enabled: boolean;
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
