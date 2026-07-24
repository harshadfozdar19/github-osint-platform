export type GitHubResource =
  | 'core'
  | 'search'
  | 'graphql'
  | 'integration_manifest'
  | 'code_scanning_upload'
  | 'secondary';

export interface GitHubRateLimitSnapshot {
  resource: GitHubResource;
  limit: number;
  remaining: number;
  used: number;
  /** Unix ms when the window resets */
  resetAt: number;
  updatedAt: number;
}

export interface GitHubPauseState {
  paused: boolean;
  pausedUntil: number | null;
  reason: string | null;
  resource: GitHubResource | null;
}

export interface WorkspaceGitHubBudget {
  workspaceId: string;
  day: string;
  used: number;
  limit: number;
  remaining: number;
  inFlight: number;
  maxConcurrency: number;
}

export interface GitHubRateLimitStatus {
  configured: boolean;
  primary: Record<string, GitHubRateLimitSnapshot | null>;
  pause: GitHubPauseState;
  secondaryRetryAfterUntil: number | null;
  workspace: WorkspaceGitHubBudget | null;
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

export interface GitHubRequestContext {
  workspaceId?: string;
  scanJobId?: string;
  signal?: AbortSignal;
  /** Override resource classification when known */
  resource?: GitHubResource;
}

/**
 * Rate-limit/pause state must be scoped by which token is actually being
 * used ('shared' env token, or a workspace's own), never just by resource.
 * Otherwise a rate limit hit on one token would incorrectly pause every
 * other token sharing that resource key — including a workspace's own,
 * completely separate GitHub quota.
 */
export type TokenScope = 'shared' | `workspace:${string}`;

export const REDIS_KEYS = {
  rateLimit: (scope: TokenScope, resource: string) =>
    `github:ratelimit:${scope}:${resource}`,
  pause: (scope: TokenScope) => `github:ratelimit:pause:${scope}`,
  secondary: (scope: TokenScope) => `github:ratelimit:secondary:${scope}`,
  budget: (workspaceId: string, day: string) =>
    `github:budget:${workspaceId}:${day}`,
  concurrency: (workspaceId: string) => `github:concurrency:${workspaceId}`,
  globalConcurrency: 'github:concurrency:global',
  pausedScans: 'github:paused-scans',
  metrics: 'github:metrics',
} as const;
