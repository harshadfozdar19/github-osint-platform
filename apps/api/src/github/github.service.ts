import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitHubHttpClient } from './github-http.client';
import { GitHubRateLimitStore } from './github-rate-limit.store';
import {
  GitHubRateLimitStatus,
  GitHubRequestContext,
  GitHubResource,
} from './github-rate-limit.types';
import { GitHubClientError, isGitHubClientError } from './github.errors';
import { utcDayKey } from './github.utils';

export interface GitHubRepoSearchItem {
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
  /** KB, as reported by GitHub. Used to decide whether a full clone is safe to attempt. */
  size?: number;
}

export interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepoSearchItem[];
}

export interface GitHubContentFile {
  path: string;
  type: string;
  size: number;
  download_url: string | null;
  content?: string;
  encoding?: string;
}

/**
 * Public GitHub facade. All outbound GitHub traffic goes through GitHubHttpClient.
 */
@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private readonly maxFileBytes: number;

  constructor(
    private readonly config: ConfigService,
    private readonly http: GitHubHttpClient,
    private readonly store: GitHubRateLimitStore,
  ) {
    this.maxFileBytes = Number(
      this.config.get('MAX_FILE_SIZE') ||
        this.config.get('SCAN_MAX_FILE_SIZE') ||
        this.config.get('GITHUB_MAX_FILE_BYTES') ||
        51200,
    );
  }

  isConfigured(): boolean {
    return this.http.isConfigured();
  }

  /** True if this workspace can make GitHub calls: its own token, or the shared one. */
  isConfiguredForWorkspace(workspaceId?: string): Promise<boolean> {
    return this.http.isConfiguredForWorkspace(workspaceId);
  }

  /** True when this workspace's own pause / secondary limit is active (scoped by which token it uses). */
  async isRateLimited(workspaceId?: string): Promise<boolean> {
    const scope = await this.http.scopeFor(workspaceId);
    const pause = await this.store.getPause(scope);
    if (pause.paused) return true;
    const secondary = await this.store.getSecondaryRetryAfterUntil(scope);
    return secondary !== null;
  }

  async getPausedUntil(workspaceId?: string): Promise<number | null> {
    const scope = await this.http.scopeFor(workspaceId);
    const secondary = await this.store.getSecondaryRetryAfterUntil(scope);
    const pause = await this.store.getPause(scope);
    const candidates = [secondary, pause.pausedUntil].filter(
      (v): v is number => typeof v === 'number' && v > Date.now(),
    );
    if (candidates.length === 0) return null;
    return Math.max(...candidates);
  }

  async searchRepositories(
    query: string,
    page = 1,
    perPage = 10,
    ctx: GitHubRequestContext = {},
  ): Promise<GitHubSearchResponse> {
    this.assertSafeQuery(query);
    const res = await this.http.request<GitHubSearchResponse>(
      'GET',
      '/search/repositories',
      {
        params: {
          q: query,
          sort: 'updated',
          order: 'desc',
          page,
          per_page: Math.min(perPage, 100),
        },
        ctx: { ...ctx, resource: 'search' },
        resourceHint: 'search',
        useEtag: false,
      },
    );
    return res.data;
  }

  /**
   * Code search — used for filename/secret-pattern discovery.
   * Maps hits back to repositories for the existing analysis pipeline.
   */
  async searchCode(
    query: string,
    page = 1,
    perPage = 10,
    ctx: GitHubRequestContext = {},
  ): Promise<GitHubSearchResponse> {
    this.assertSafeQuery(query);
    const res = await this.http.request<{
      total_count: number;
      incomplete_results: boolean;
      items: Array<{
        repository?: {
          id: number;
          full_name: string;
          html_url: string;
          description: string | null;
          stargazers_count?: number;
          forks_count?: number;
          fork?: boolean;
          language?: string | null;
          topics?: string[];
          created_at?: string;
          updated_at?: string;
          pushed_at?: string;
          owner?: { login: string };
          name?: string;
          default_branch?: string;
        };
      }>;
    }>('GET', '/search/code', {
      params: {
        q: query,
        page,
        per_page: Math.min(perPage, 100),
      },
      ctx: { ...ctx, resource: 'search' },
      resourceHint: 'search',
      useEtag: false,
    });

    const byId = new Map<number, GitHubRepoSearchItem>();
    for (const item of res.data.items || []) {
      const repo = item.repository;
      if (!repo?.id || !repo.full_name || !repo.owner?.login) continue;
      if (byId.has(repo.id)) continue;
      const [ownerLogin, name] = repo.full_name.split('/');
      byId.set(repo.id, {
        id: repo.id,
        full_name: repo.full_name,
        html_url: repo.html_url || `https://github.com/${repo.full_name}`,
        description: repo.description || null,
        stargazers_count: repo.stargazers_count || 0,
        forks_count: repo.forks_count || 0,
        fork: repo.fork === true,
        language: repo.language || null,
        topics: repo.topics || [],
        created_at: repo.created_at || new Date(0).toISOString(),
        updated_at: repo.updated_at,
        pushed_at:
          repo.pushed_at || repo.updated_at || new Date(0).toISOString(),
        owner: { login: repo.owner?.login || ownerLogin },
        name: repo.name || name,
        default_branch: repo.default_branch,
      });
    }

    return {
      total_count: res.data.total_count,
      incomplete_results: res.data.incomplete_results,
      items: [...byId.values()],
    };
  }

  async listTreePaths(
    owner: string,
    repo: string,
    sha: string,
    ctx: GitHubRequestContext = {},
  ): Promise<string[]> {
    this.assertSafeOwnerRepo(owner, repo);
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) return [];
    try {
      const res = await this.http.request<{
        tree?: Array<{ path?: string; type?: string }>;
        truncated?: boolean;
      }>('GET', `/repos/${owner}/${repo}/git/trees/${sha}`, {
        params: { recursive: '1' },
        ctx,
        resourceHint: 'core',
        useEtag: false,
      });
      const paths = (res.data.tree || [])
        .filter((t) => t.type === 'blob' && t.path)
        .map((t) => t.path as string)
        .filter((p) => this.isSafeRelativePath(p))
        .slice(0, 800);
      if (res.data.truncated) {
        this.logger.debug(
          `Tree truncated for ${owner}/${repo}; using first ${paths.length} paths`,
        );
      }
      return paths;
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return [];
      throw error;
    }
  }

  async listUserRepos(
    owner: string,
    perPage = 10,
    ctx: GitHubRequestContext = {},
  ): Promise<GitHubRepoSearchItem[]> {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner)) {
      throw new GitHubClientError('Invalid GitHub owner', 'VALIDATION');
    }
    try {
      const res = await this.http.request<
        Array<{
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
        }>
      >('GET', `/users/${owner}/repos`, {
        params: {
          per_page: Math.min(perPage, 30),
          sort: 'updated',
          direction: 'desc',
          type: 'owner',
        },
        ctx,
        resourceHint: 'core',
        useEtag: false,
      });
      return (res.data || []).map((r) => ({
        id: r.id,
        full_name: r.full_name,
        html_url: r.html_url,
        description: r.description,
        stargazers_count: r.stargazers_count,
        forks_count: r.forks_count,
        fork: r.fork,
        language: r.language,
        topics: r.topics || [],
        created_at: r.created_at,
        updated_at: r.updated_at,
        pushed_at: r.pushed_at,
        owner: { login: r.owner.login },
        name: r.name,
        default_branch: r.default_branch,
      }));
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return [];
      throw error;
    }
  }

  async listForks(
    owner: string,
    repo: string,
    perPage = 10,
    ctx: GitHubRequestContext = {},
  ): Promise<GitHubRepoSearchItem[]> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const res = await this.http.request<
        Array<{
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
        }>
      >('GET', `/repos/${owner}/${repo}/forks`, {
        params: {
          per_page: Math.min(perPage, 30),
          sort: 'newest',
        },
        ctx,
        resourceHint: 'core',
        useEtag: false,
      });
      return (res.data || []).map((r) => ({
        id: r.id,
        full_name: r.full_name,
        html_url: r.html_url,
        description: r.description,
        stargazers_count: r.stargazers_count,
        forks_count: r.forks_count,
        fork: r.fork,
        language: r.language,
        topics: r.topics || [],
        created_at: r.created_at,
        updated_at: r.updated_at,
        pushed_at: r.pushed_at,
        owner: { login: r.owner.login },
        name: r.name,
        default_branch: r.default_branch,
      }));
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return [];
      throw error;
    }
  }

  async getRepositoryHead(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<{
    defaultBranch: string;
    sha: string;
    updatedAt?: string;
    pushedAt?: string;
    etag?: string;
  } | null> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const meta = await this.http.request<{
        default_branch?: string;
        updated_at?: string;
        pushed_at?: string;
      }>('GET', `/repos/${owner}/${repo}`, {
        ctx,
        resourceHint: 'core',
        useEtag: true,
      });
      const defaultBranch = meta.data.default_branch || 'main';
      if (!/^[A-Za-z0-9_.\-/]+$/.test(defaultBranch)) {
        return null;
      }
      const ref = await this.http.request<{ object?: { sha?: string } }>(
        'GET',
        `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`,
        { ctx, resourceHint: 'core', useEtag: false },
      );
      const sha = ref.data.object?.sha || '';
      if (!sha) return null;
      return {
        defaultBranch,
        sha,
        updatedAt: meta.data.updated_at,
        pushedAt: meta.data.pushed_at,
        etag: meta.headers.etag,
      };
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return null;
      throw error;
    }
  }

  async listRootPaths(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<string[]> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const res = await this.http.request<GitHubContentFile[]>(
        'GET',
        `/repos/${owner}/${repo}/contents`,
        { ctx, resourceHint: 'core', useEtag: true },
      );
      if (!Array.isArray(res.data)) return [];
      return res.data.map((f) => f.path);
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'NOT_FOUND') return [];
      if (isGitHubClientError(error) && !error.retryable) return [];
      throw error;
    }
  }

  async getReadme(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<string> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const res = await this.http.request<{
        content?: string;
        encoding?: string;
        size?: number;
      }>('GET', `/repos/${owner}/${repo}/readme`, {
        ctx,
        resourceHint: 'core',
        useEtag: true,
      });
      const data = res.data;
      if (!data.content || data.encoding !== 'base64') return '';
      if ((data.size || 0) > this.maxFileBytes) return '';
      return Buffer.from(data.content, 'base64')
        .toString('utf8')
        .slice(0, this.maxFileBytes);
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'NOT_FOUND') return '';
      if (isGitHubClientError(error) && !error.retryable) return '';
      throw error;
    }
  }

  /**
   * Recent commits reachable from `sha` (branch name or commit SHA).
   * Used to look for secrets committed and later removed — content analysis
   * of the current tree alone never sees those.
   */
  async listRecentCommits(
    owner: string,
    repo: string,
    sha: string,
    perPage = 15,
    ctx: GitHubRequestContext = {},
  ): Promise<string[]> {
    this.assertSafeOwnerRepo(owner, repo);
    if (!/^[A-Za-z0-9_.\-/]{1,100}$/.test(sha)) return [];
    try {
      const res = await this.http.request<Array<{ sha: string }>>(
        'GET',
        `/repos/${owner}/${repo}/commits`,
        {
          params: { sha, per_page: Math.min(perPage, 30) },
          ctx,
          resourceHint: 'core',
          useEtag: false,
        },
      );
      return (res.data || []).map((c) => c.sha).filter(Boolean);
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return [];
      throw error;
    }
  }

  /**
   * Per-file unified diff patches for one commit. GitHub omits `patch` for
   * very large or binary files — that's an acceptable bound, not a bug.
   */
  async getCommitPatch(
    owner: string,
    repo: string,
    sha: string,
    ctx: GitHubRequestContext = {},
  ): Promise<Array<{ filename: string; patch?: string; status: string }>> {
    this.assertSafeOwnerRepo(owner, repo);
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) return [];
    try {
      const res = await this.http.request<{
        files?: Array<{ filename: string; patch?: string; status: string }>;
      }>('GET', `/repos/${owner}/${repo}/commits/${sha}`, {
        ctx,
        resourceHint: 'core',
        useEtag: false,
      });
      return res.data.files || [];
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return [];
      throw error;
    }
  }

  async getSmallTextFile(
    owner: string,
    repo: string,
    path: string,
    ctx: GitHubRequestContext = {},
  ): Promise<string | null> {
    this.assertSafeOwnerRepo(owner, repo);
    if (!this.isSafeRelativePath(path)) return null;
    try {
      const res = await this.http.request<GitHubContentFile>(
        'GET',
        `/repos/${owner}/${repo}/contents/${path}`,
        { ctx, resourceHint: 'core', useEtag: true },
      );
      const data = res.data;
      if (data.type !== 'file' || (data.size || 0) > this.maxFileBytes)
        return null;
      if (!data.content || data.encoding !== 'base64') return null;
      const text = Buffer.from(data.content, 'base64').toString('utf8');
      if (text.includes('\u0000')) return null;
      return text.slice(0, this.maxFileBytes);
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return null;
      throw error;
    }
  }

  async getStatus(workspaceId?: string): Promise<GitHubRateLimitStatus> {
    const scope = await this.http.scopeFor(workspaceId);
    const usesSharedToken = scope === 'shared';
    const resources: GitHubResource[] = ['core', 'search', 'secondary'];
    const primary: GitHubRateLimitStatus['primary'] = {};
    for (const resource of resources) {
      if (resource === 'secondary') continue;
      primary[resource] = await this.store.getSnapshot(scope, resource);
    }

    const thresholds = this.http.getThresholds();
    const pause = await this.store.getPause(scope);
    const secondaryRetryAfterUntil =
      await this.store.getSecondaryRetryAfterUntil(scope);
    const metricsRaw = await this.store.getMetrics();
    const pausedScanCount = await this.store.countPausedScans();

    // The daily "budget" is a fairness cap for workspaces sharing one token —
    // meaningless once a workspace has switched to its own dedicated token.
    const workspace =
      workspaceId && usesSharedToken
        ? await this.store.workspaceBudget(
            workspaceId,
            thresholds.workspaceDailyBudget,
            thresholds.workspaceMaxConcurrency,
          )
        : null;

    const configuredForWorkspace =
      await this.isConfiguredForWorkspace(workspaceId);
    const warnings: string[] = [];
    if (!configuredForWorkspace) {
      warnings.push(
        'No GitHub token available for this workspace (shared GITHUB_TOKEN not set and no workspace token configured) — live scans are skipped.',
      );
    }
    if (pause.paused) {
      warnings.push(
        `GitHub API paused until ${new Date(pause.pausedUntil || 0).toISOString()}: ${pause.reason}`,
      );
    }
    if (secondaryRetryAfterUntil) {
      warnings.push(
        `Secondary rate limit active until ${new Date(secondaryRetryAfterUntil).toISOString()}`,
      );
    }
    for (const snap of Object.values(primary)) {
      if (snap && snap.remaining <= thresholds.lowRemaining) {
        warnings.push(
          `${snap.resource} quota low: ${snap.remaining}/${snap.limit} remaining (resets ${new Date(snap.resetAt).toISOString()})`,
        );
      }
    }
    if (workspace && workspace.remaining <= Math.ceil(workspace.limit * 0.1)) {
      warnings.push(
        `Workspace daily GitHub budget nearly exhausted (${workspace.used}/${workspace.limit} on ${utcDayKey()})`,
      );
    }
    if (pausedScanCount > 0) {
      warnings.push(
        `${pausedScanCount} scan(s) paused waiting for GitHub quota`,
      );
    }

    return {
      configured: configuredForWorkspace,
      primary,
      pause,
      secondaryRetryAfterUntil,
      workspace,
      pausedScanCount,
      warnings,
      metrics: {
        requestsTotal: metricsRaw.requestsTotal || 0,
        retriesTotal: metricsRaw.retriesTotal || 0,
        rateLimitHits: metricsRaw.rateLimitHits || 0,
        budgetRejects: metricsRaw.budgetRejects || 0,
        secondaryHits: metricsRaw.secondaryHits || 0,
      },
      thresholds,
    };
  }

  clearScanPause(scanJobId: string) {
    return this.store.clearScanPaused(scanJobId);
  }

  markScanPause(scanJobId: string, until: number) {
    return this.store.markScanPaused(scanJobId, until);
  }

  private assertSafeOwnerRepo(owner: string, repo: string) {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new GitHubClientError('Invalid GitHub owner/repo', 'VALIDATION');
    }
  }

  private assertSafeQuery(query: string) {
    if (!query || query.length > 256) {
      throw new GitHubClientError('Invalid search query', 'VALIDATION');
    }
  }

  private isSafeRelativePath(path: string): boolean {
    if (
      !path ||
      path.includes('..') ||
      path.startsWith('/') ||
      path.includes('\\')
    ) {
      return false;
    }
    return /^[A-Za-z0-9_./@+-]+$/.test(path);
  }
}

export { isGitHubClientError, GitHubClientError };
