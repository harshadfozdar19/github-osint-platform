export const QUEUE_SCAN_ORCHESTRATOR = 'scan-orchestrator';
export const QUEUE_GITHUB_SEARCH = 'github-search';
export const QUEUE_REPOSITORY_ANALYSIS = 'repository-analysis';
export const QUEUE_DETECTION_PROCESSING = 'detection-processing';
export const QUEUE_ALERT_DISPATCH = 'alert-dispatch';
export const QUEUE_BRANCH_ANALYSIS = 'branch-analysis';
export const QUEUE_INTENT_ASSESSMENT = 'intent-assessment';

export const ALL_SCAN_QUEUES = [
  QUEUE_SCAN_ORCHESTRATOR,
  QUEUE_GITHUB_SEARCH,
  QUEUE_REPOSITORY_ANALYSIS,
  QUEUE_DETECTION_PROCESSING,
  QUEUE_ALERT_DISPATCH,
  QUEUE_BRANCH_ANALYSIS,
  QUEUE_INTENT_ASSESSMENT,
] as const;

export type ScanQueueName = (typeof ALL_SCAN_QUEUES)[number];

export interface ScanOrchestratorJobData {
  workspaceId: string;
  scanJobId: string;
  type: 'manual' | 'scheduled';
  triggeredBy?: string;
  configHash: string;
  mode?:
    | 'incremental'
    | 'full'
    | 'failed_only'
    | 'analyze_pending'
    | 'reanalyze_existing'
    | 'branch_analysis';
  forceFullScan?: boolean;
  rulesetVersion?: string;
}

export interface GitHubSearchJobData {
  workspaceId: string;
  scanJobId: string;
  query: string;
  queryIndex: number;
  maxRepos: number;
  mode?:
    | 'incremental'
    | 'full'
    | 'failed_only'
    | 'analyze_pending'
    | 'reanalyze_existing'
    | 'branch_analysis';
  forceFullScan?: boolean;
  rulesetVersion?: string;
  /** Resume from this page (1-based). */
  page?: number;
  /** repositories (default) or code search API */
  searchKind?: 'repositories' | 'code';
  family?: string;
  /** When true, discovered repos are recorded (Repository.pendingAnalysis=true) but never enqueued for content analysis - see ScanJob.discoveryOnly. */
  discoveryOnly?: boolean;
  /**
   * How many times this exact query has already been produced by
   * maybeSplitOversizedDateRangeQuery's recursive bisection - 0 for an
   * original, never-split query. Caps worst-case fan-out for a single
   * oversized query at 2^MAX_DATE_SPLIT_DEPTH leaf queries regardless of
   * how large total_count is or how wide the (possibly synthesized)
   * created: range starts out - see that function for why an unbounded cap
   * here was a real problem.
   */
  splitDepth?: number;
  /**
   * Same idea as splitDepth, but for CODE search's second overflow-relief
   * dimension - maybeSplitOversizedCodeSizeRange's recursive `size:X..Y`
   * bisection, applied to an already language-split child (family ending
   * `-split`) that's still over the cap. Independent counter from
   * splitDepth since the two dimensions are unrelated and a query is only
   * ever subject to one of them (repositories: date; code: size).
   */
  sizeSplitDepth?: number;
}

export interface RepositoryAnalysisJobData {
  workspaceId: string;
  scanJobId: string;
  mode?:
    | 'incremental'
    | 'full'
    | 'failed_only'
    | 'analyze_pending'
    | 'reanalyze_existing'
    | 'branch_analysis';
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
    /** Absent for a code-search discovery whose embedded repo object never includes this - see GitHubRepoSearchItem.created_at. Must not be defaulted to an arbitrary date; treat missing as unknown. */
    created_at?: string;
    updated_at?: string;
    pushed_at?: string;
    owner: { login: string };
    name: string;
    default_branch?: string;
    size?: number;
  };
  /**
   * Every enabled brand for the workspace, not just whichever one happened
   * to superficially match this repo's name/description/topics at search
   * time - fetchRepositoryContext greps the whole repo against all of them
   * and picks the strongest hit, so a repo whose only brand mention is deep
   * in file content still gets attributed correctly.
   */
  brands: Array<{
    id: string;
    name: string;
    aliases: string[];
    trustedGithubOwners?: string[];
    keywords?: string[];
  }>;
  /**
   * This repo was reached by exhaustively enumerating a brand's own
   * trustedGithubOwners accounts (internal secret audit), not by searching
   * GitHub for mentions of the brand - the detection stage uses this to
   * skip impersonation/phishing/fake-apk/low-reputation rules (meaningless
   * against a confirmed-own repo) while still running secrets detection.
   */
  internalAudit?: boolean;
}

export interface DetectionProcessingJobData {
  workspaceId: string;
  scanJobId: string;
  repositoryDbId: string;
  githubId: number;
  internalAudit?: boolean;
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
    /** Owner GitHub account's own created_at - see RepoAnalysisContext.ownerAccountCreatedAt. */
    ownerAccountCreatedAt?: string;
    ownerFollowers?: number;
    ownerPublicRepos?: number;
    filePaths: string[];
    readmeText: string;
    readmePath?: string;
    smallFileTexts: Array<{ path: string; content: string }>;
    matchedBrandId?: string;
    matchedBrandName?: string;
    matchedBrandAliases?: string[];
    matchedBrandTrustedOwners?: string[];
    matchedBrandKeywords?: string[];
    commitMessages?: string[];
    commitAuthors?: string[];
    /** Full-repo git-grep hits for the brand's name/aliases - see RepoAnalysisContext.brandFileMatches. */
    brandFileMatches?: Array<{
      alias: string;
      path: string;
      lineNumber: number;
      line: string;
    }>;
    /** Full-repo git-grep hits for the brand's own curated keywords - see RepoAnalysisContext.keywordFileMatches. */
    keywordFileMatches?: Array<{
      alias: string;
      path: string;
      lineNumber: number;
      line: string;
    }>;
    /** Raw full-repo secret-anchor hits, not yet regex-verified - see RepoAnalysisContext.fullRepoSecretCandidates. */
    fullRepoSecretCandidates?: Array<{
      path: string;
      lineNumber: number;
      line: string;
    }>;
  };
}

export interface AlertDispatchJobData {
  workspaceId: string;
  scanJobId: string;
  findingId: string;
}

/**
 * Triggers one repository's LLM intent/risk assessment - enqueued from
 * DetectionProcessingProcessor only for a genuinely new or reopened finding
 * on an external (non-internal-audit) scan, mirroring
 * ScanPipelineService.checkLiveness's own "only worth the extra cost once
 * something else has flagged this repo" gating.
 */
export interface IntentAssessmentJobData {
  workspaceId: string;
  repositoryId: string;
  findingId: string;
}

/**
 * On-demand: clone and content-scan exactly ONE already-known repository's
 * ONE specific branch - see ScanMode.BRANCH_ANALYSIS. Deliberately far
 * simpler than RepositoryAnalysisJobData: no incremental-rescan decision (no
 * commitSha-based skip - an explicit ask always runs), no discovery-derived
 * repo metadata (the repo is already fully known), and never touches
 * Repository's own default-branch bookkeeping - see BranchAnalysisProcessor.
 */
export interface BranchAnalysisJobData {
  workspaceId: string;
  scanJobId: string;
  repositoryDbId: string;
  githubId: number;
  fullName: string;
  branch: string;
  brands: Array<{
    id: string;
    name: string;
    aliases: string[];
    trustedGithubOwners?: string[];
    keywords?: string[];
  }>;
}

export const QUEUE_KEYWORD_ROTATION = 'keyword-rotation';

/**
 * Payload for the delayed "this keyword's time slot is up, hand off to the
 * next one" timer - see KeywordRotationService.advance. `token` disambiguates
 * this specific timer from any other one scheduled for the same workspace (a
 * fresh token is minted every time a new slot starts), so a stale timer left
 * over from a slot that already ended early can be told apart from the
 * current one and ignored instead of firing a spurious advance.
 */
export interface KeywordRotationJobData {
  workspaceId: string;
  token: string;
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

export function intentAssessmentJobId(findingId: string): string {
  return `intent-assessment-${findingId}`;
}

export function branchAnalysisJobId(scanJobId: string): string {
  return `scan-${scanJobId}-branch-analysis`;
}

export function keywordRotationJobId(
  workspaceId: string,
  token: string,
): string {
  return `keyword-rotation-${workspaceId}-${token}`;
}
