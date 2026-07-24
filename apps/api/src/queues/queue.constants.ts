export const QUEUE_SCAN_ORCHESTRATOR = 'scan-orchestrator';
export const QUEUE_GITHUB_SEARCH = 'github-search';
export const QUEUE_REPOSITORY_ANALYSIS = 'repository-analysis';
export const QUEUE_DETECTION_PROCESSING = 'detection-processing';
export const QUEUE_ALERT_DISPATCH = 'alert-dispatch';

export const ALL_SCAN_QUEUES = [
  QUEUE_SCAN_ORCHESTRATOR,
  QUEUE_GITHUB_SEARCH,
  QUEUE_REPOSITORY_ANALYSIS,
  QUEUE_DETECTION_PROCESSING,
  QUEUE_ALERT_DISPATCH,
] as const;

export type ScanQueueName = (typeof ALL_SCAN_QUEUES)[number];

export interface ScanOrchestratorJobData {
  workspaceId: string;
  scanJobId: string;
  type: 'manual' | 'scheduled';
  triggeredBy?: string;
  configHash: string;
  mode?: 'incremental' | 'full' | 'failed_only';
  forceFullScan?: boolean;
  rulesetVersion?: string;
}

export interface GitHubSearchJobData {
  workspaceId: string;
  scanJobId: string;
  query: string;
  queryIndex: number;
  maxRepos: number;
  mode?: 'incremental' | 'full' | 'failed_only';
  forceFullScan?: boolean;
  rulesetVersion?: string;
  /** Resume from this page (1-based). */
  page?: number;
  /** repositories (default) or code search API */
  searchKind?: 'repositories' | 'code';
  family?: string;
}

export interface RepositoryAnalysisJobData {
  workspaceId: string;
  scanJobId: string;
  mode?: 'incremental' | 'full' | 'failed_only';
  forceFullScan?: boolean;
  rulesetVersion?: string;
  resumed?: boolean;
  repo: {
    id: number;
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    fork: boolean;
    language: string | null;
    topics?: string[];
    created_at: string;
    updated_at?: string;
    pushed_at: string;
    owner: { login: string };
    name: string;
    default_branch?: string;
  };
  matchedBrand?: {
    id: string;
    name: string;
    aliases: string[];
  };
}

export interface DetectionProcessingJobData {
  workspaceId: string;
  scanJobId: string;
  repositoryDbId: string;
  githubId: number;
  fullName: string;
  commitSha?: string;
  defaultBranch?: string;
  contentEtag?: string;
  rulesetVersion?: string;
  resumed?: boolean;
  ctx: {
    fullName: string;
    owner: string;
    name: string;
    description: string;
    topics: string[];
    language: string;
    stars: number;
    forks: number;
    isFork: boolean;
    githubCreatedAt?: string;
    githubPushedAt?: string;
    filePaths: string[];
    readmeText: string;
    smallFileTexts: Array<{ path: string; content: string }>;
    matchedBrandName?: string;
    matchedBrandAliases?: string[];
  };
}

export interface AlertDispatchJobData {
  workspaceId: string;
  scanJobId: string;
  findingId: string;
}

export function orchestratorJobId(scanJobId: string): string {
  return `scan-${scanJobId}-orchestrator`;
}

export function githubSearchJobId(
  scanJobId: string,
  queryIndex: number,
  page = 1,
  searchKind: 'repositories' | 'code' = 'repositories',
): string {
  return `scan-${scanJobId}-search-${searchKind}-${queryIndex}-p${page}`;
}

export function repoAnalysisJobId(scanJobId: string, githubId: number): string {
  return `scan-${scanJobId}-repo-${githubId}`;
}

export function detectionJobId(scanJobId: string, githubId: number): string {
  return `scan-${scanJobId}-detect-${githubId}`;
}

export function alertJobId(scanJobId: string, findingId: string): string {
  return `scan-${scanJobId}-alert-${findingId}`;
}
