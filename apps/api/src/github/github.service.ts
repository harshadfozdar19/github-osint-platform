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
  /**
   * Absent for a code-search result whose embedded `repository` object
   * GitHub simply never populates with this - see searchCode, which tries a
   * direct repo-metadata fetch to backfill it for a newly-discovered repo,
   * but genuinely may still come up empty (rate-limited, repo deleted since,
   * etc). Callers must treat a missing value as "unknown", never default it
   * to an arbitrary date - see Repository.githubCreatedAt.
   */
  created_at?: string;
  updated_at?: string;
  pushed_at?: string;
  owner: { login: string };
  name: string;
  default_branch?: string;
  /** KB, as reported by GitHub. Used to decide whether a full clone is safe to attempt. */
  size?: number;
  /**
   * Set only for a code-search result: the path of the FIRST file GitHub
   * reported a hit in for this repo on this page - a code search can return
   * several matching files per repo, but this dedupes to one (see
   * searchCode's byId map), just enough to answer "which file actually
   * matched" for discovery-time evidence without a second API call.
   */
  matchedPath?: string;
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

  /**
   * Verifies a token actually works and immediately populates its quota
   * snapshot, instead of leaving the dashboard's quota panel blank until
   * the first real scan happens to make a GitHub call. Throws (AUTH code)
   * if GitHub rejects the token.
   */
  refreshRateLimitStatus(workspaceId: string): Promise<void> {
    return this.http.refreshRateLimitSnapshot({ workspaceId });
  }

  /** True if this workspace can make GitHub calls: its own token, or the shared one. */
  isConfiguredForWorkspace(workspaceId?: string): Promise<boolean> {
    return this.http.isConfiguredForWorkspace(workspaceId);
  }

  /** True when this workspace's own pause / secondary limit is active (scoped by which token it uses). */
  async isRateLimited(workspaceId?: string): Promise<boolean> {
    const scope = await this.http.scopeFor(workspaceId);
    const pause = await this.store.getAnyPause(scope);
    if (pause.paused) return true;
    const secondary = await this.store.getSecondaryRetryAfterUntil(scope);
    return secondary !== null;
  }

  async getPausedUntil(workspaceId?: string): Promise<number | null> {
    const scope = await this.http.scopeFor(workspaceId);
    const secondary = await this.store.getSecondaryRetryAfterUntil(scope);
    const pause = await this.store.getAnyPause(scope);
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
        path?: string;
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
      // Code search has its own, much stricter budget (10/min vs repo
      // search's 30/min) and its own pause/quota bucket - tagging it
      // 'search' here made paceRequest space these out at the repo-search
      // interval and enforcePauseAndQuota check the wrong bucket's pause
      // state, so a code-search-specific 403 wouldn't proactively slow
      // anything down until a reactive response-header round trip
      // corrected it.
      ctx: { ...ctx, resource: 'code_search' },
      resourceHint: 'code_search',
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
        // No epoch/placeholder fallback here - an absent value must stay
        // absent (see GitHubRepoSearchItem.created_at) so it reads as
        // "unknown" downstream instead of a bogus 1 Jan 1970. The discovery
        // processor tries a direct repo-metadata fetch to fill these in for
        // a genuinely new repo right after this - see
        // GitHubSearchProcessor's use of getRepositoryTimestamps.
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        pushed_at: repo.pushed_at || repo.updated_at,
        owner: { login: repo.owner?.login || ownerLogin },
        name: repo.name || name,
        matchedPath: item.path,
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

  /**
   * The account's own profile - age, followers, public repo count - as
   * opposed to any of its individual repos. A repo's own stars/age (already
   * tracked elsewhere in RepoAnalysisContext) says nothing about who's
   * actually behind it; this is the one call that answers "is this a real,
   * established GitHub identity, or a throwaway account spun up to host one
   * impersonation repo." A 404 (deleted/renamed account - rare but possible
   * between discovery and analysis) is treated the same as "no data
   * available" everywhere else in this service, not as an error.
   */
  async getUserProfile(
    owner: string,
    ctx: GitHubRequestContext = {},
  ): Promise<{
    createdAt?: string;
    followers?: number;
    publicRepos?: number;
  } | null> {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner)) {
      throw new GitHubClientError('Invalid GitHub owner', 'VALIDATION');
    }
    try {
      const res = await this.http.request<{
        created_at?: string;
        followers?: number;
        public_repos?: number;
      }>('GET', `/users/${owner}`, {
        ctx,
        resourceHint: 'core',
        useEtag: true,
      });
      return {
        createdAt: res.data.created_at,
        followers: res.data.followers,
        publicRepos: res.data.public_repos,
      };
    } catch (error) {
      if (isGitHubClientError(error) && !error.retryable) return null;
      throw error;
    }
  }

  /**
   * Exhaustive, paginated listing of every repo a trusted-owner GitHub
   * account/org has - for the internal-audit use case ("scan every repo
   * WE own for exposed secrets"), which is a fundamentally different job
   * from `listUserRepos` above: that one is capped to a single small page,
   * used reactively to fan out from one already-confirmed bad actor's other
   * repos. This one needs to be complete, since a company's own repo count
   * isn't bounded by anything we control. Tries the organization endpoint
   * first (works only for actual GitHub orgs), falling back to the user
   * endpoint on 404 - the caller doesn't need to know in advance which kind
   * of account `owner` is.
   *
   * Excludes forks: GitHub's org/user repo-listing endpoints return forks
   * by default, which can easily outnumber the account's own repos (e.g. an
   * engineering org that forks a lot of upstream OSS internally) and aren't
   * code the account authored - auditing them for "did WE leak a secret"
   * mostly just burns REST quota rescanning someone else's history.
   */
  async listAllOwnerRepos(
    owner: string,
    ctx: GitHubRequestContext = {},
  ): Promise<GitHubRepoSearchItem[]> {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner)) {
      throw new GitHubClientError('Invalid GitHub owner', 'VALIDATION');
    }
    const perPage = 100;
    // Safety cap, not an expected ceiling - stops a pathological account
    // from turning one audit scan into an unbounded REST-quota drain.
    const maxPages = 20;

    const fetchAllPages = async (
      path: string,
      extraParams: Record<string, string> = {},
    ): Promise<{ items: GitHubRepoSearchItem[]; found: boolean }> => {
      const items: GitHubRepoSearchItem[] = [];
      for (let page = 1; page <= maxPages; page++) {
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
              size?: number;
            }>
          >('GET', path, {
            params: {
              per_page: perPage,
              page,
              sort: 'updated',
              direction: 'desc',
              ...extraParams,
            },
            ctx,
            resourceHint: 'core',
            useEtag: false,
          });
          const batch = res.data || [];
          for (const r of batch) {
            if (r.fork) continue;
            items.push({
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
              size: r.size,
            });
          }
          if (batch.length < perPage) break;
        } catch (error) {
          if (isGitHubClientError(error) && error.code === 'NOT_FOUND') {
            return { items, found: false };
          }
          if (isGitHubClientError(error) && !error.retryable) {
            return { items, found: true };
          }
          throw error;
        }
      }
      return { items, found: true };
    };

    const org = await fetchAllPages(`/orgs/${owner}/repos`);
    if (org.found) return org.items;

    const user = await fetchAllPages(`/users/${owner}/repos`, {
      type: 'owner',
    });
    return user.items;
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

  /**
   * Every branch this repo has, not just the default one - GitHub's search
   * API only ever indexes a repo's default branch (see query-families.ts's
   * secret-filename comment), so this is the only way to even discover
   * that a side branch exists, let alone what's on it. Powers the
   * "Branches" picker on the Repositories page - see
   * ScanMode.BRANCH_ANALYSIS for what happens once one is picked.
   */
  async listBranches(
    owner: string,
    repo: string,
    perPage = 100,
    ctx: GitHubRequestContext = {},
  ): Promise<Array<{ name: string; sha: string; protected: boolean }>> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const res = await this.http.request<
        Array<{
          name: string;
          commit: { sha: string };
          protected?: boolean;
        }>
      >('GET', `/repos/${owner}/${repo}/branches`, {
        params: { per_page: Math.min(perPage, 100) },
        ctx,
        resourceHint: 'core',
        useEtag: false,
      });
      return (res.data || []).map((b) => ({
        name: b.name,
        sha: b.commit.sha,
        protected: b.protected === true,
      }));
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'NOT_FOUND') return [];
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

  /**
   * Direct repo-metadata fetch for just created_at/pushed_at - used to
   * backfill a code-search discovery, whose embedded `repository` object
   * never includes either (see GitHubRepoSearchItem.created_at). Best-effort
   * on every failure (not just non-retryable ones, unlike most other methods
   * here): this only ever supplements a date the UI would otherwise show as
   * "unknown," so a transient error here must never fail the discovery scan
   * itself - null just means the date stays unknown.
   */
  async getRepositoryTimestamps(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<{ createdAt?: string; pushedAt?: string } | null> {
    try {
      this.assertSafeOwnerRepo(owner, repo);
      const res = await this.http.request<{
        created_at?: string;
        updated_at?: string;
        pushed_at?: string;
      }>('GET', `/repos/${owner}/${repo}`, {
        ctx,
        resourceHint: 'core',
        useEtag: true,
      });
      return {
        createdAt: res.data.created_at,
        pushedAt: res.data.pushed_at || res.data.updated_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Does this repo have a live, GitHub-hosted deployment - direct proof of
   * an active site rather than dormant source code. Routed through the same
   * rate-limited/token-aware http client as every other GitHub call here
   * (not a raw fetch), so it counts against the same quota tracking and
   * respects a workspace's own configured token. A 404 (no Pages site
   * configured) is the overwhelmingly common case, not an error.
   */
  async getRepositoryPagesInfo(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<{ url: string; status: string } | null> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const res = await this.http.request<{
        html_url?: string;
        status?: string;
      }>('GET', `/repos/${owner}/${repo}/pages`, {
        ctx,
        resourceHint: 'core',
        useEtag: false,
      });
      if (!res.data.html_url) return null;
      return { url: res.data.html_url, status: res.data.status || 'unknown' };
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'NOT_FOUND') return null;
      if (isGitHubClientError(error) && !error.retryable) return null;
      throw error;
    }
  }

  /**
   * Top contributors by commit count. GitHub returns 204 (no body) once a
   * repo's contributor stats haven't finished computing server-side yet -
   * treated as empty rather than retried, since a later scan will pick it up.
   */
  async listContributors(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<
    Array<{ login: string; avatarUrl?: string; contributions: number }>
  > {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const res = await this.http.request<
        Array<{
          login?: string;
          avatar_url?: string;
          contributions?: number;
          type?: string;
        }>
      >('GET', `/repos/${owner}/${repo}/contributors`, {
        ctx,
        resourceHint: 'core',
        useEtag: true,
        params: { per_page: '30' },
      });
      if (!Array.isArray(res.data)) return [];
      return res.data
        .filter((c) => c.login && c.type !== 'Bot')
        .map((c) => ({
          login: c.login as string,
          avatarUrl: c.avatar_url,
          contributions: c.contributions || 0,
        }));
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'NOT_FOUND') return [];
      if (isGitHubClientError(error) && !error.retryable) return [];
      throw error;
    }
  }

  /**
   * Most recent deployment with a live environment URL - direct proof of a
   * hosted, running instance rather than dormant source. GitHub's deployment
   * list is newest-first; for that deployment we read its most recent status
   * for the `environment_url` (the deployment object itself never carries a
   * URL, only its statuses do).
   *
   * Prefers the repo's own `homepage` field over that `environment_url` when
   * one is set. The per-deployment URL is an auto-generated, unique-per-build
   * address that team-owned Vercel (and similar) projects frequently gate
   * behind their own SSO/access-protection wall - `homepage` is the stable,
   * intentionally-public alias the owner actually set for visitors, and
   * isn't subject to that gate. Deployment status still supplies the
   * environment/state labels when both are available.
   */
  async getLatestDeployment(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<{
    environment: string;
    url: string;
    state: string;
    updatedAt?: string;
  } | null> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const [meta, deployments] = await Promise.all([
        this.http.request<{ homepage?: string | null }>(
          'GET',
          `/repos/${owner}/${repo}`,
          { ctx, resourceHint: 'core', useEtag: true },
        ),
        this.http.request<
          Array<{ id?: number; environment?: string; created_at?: string }>
        >('GET', `/repos/${owner}/${repo}/deployments`, {
          ctx,
          resourceHint: 'core',
          useEtag: false,
          params: { per_page: '1' },
        }),
      ]);
      const homepage = meta.data?.homepage?.trim() || undefined;
      const deployment = deployments.data?.[0];
      // Still require an actual GitHub Deployment record with a live status
      // URL - that's the proof of a real deploy event. homepage only ever
      // substitutes which URL gets surfaced, never stands in for that proof
      // on its own (it's free-text metadata the owner can set to anything).
      if (!deployment?.id) return null;

      const statuses = await this.http.request<
        Array<{
          state?: string;
          environment_url?: string;
          created_at?: string;
        }>
      >(
        'GET',
        `/repos/${owner}/${repo}/deployments/${deployment.id}/statuses`,
        {
          ctx,
          resourceHint: 'core',
          useEtag: false,
          params: { per_page: '10' },
        },
      );
      const withUrl = (statuses.data || []).find((s) => s.environment_url);
      if (!withUrl?.environment_url) return null;

      return {
        environment: deployment.environment || 'production',
        url: homepage || withUrl.environment_url,
        state: withUrl.state || 'unknown',
        updatedAt: withUrl.created_at,
      };
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'NOT_FOUND') return null;
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

  /**
   * `path` is the README's actual repo-relative path as GitHub resolved it
   * (case and extension vary per repo - README.md, Readme.rst, readme, ...) -
   * callers need this to link back to the real file instead of guessing.
   */
  async getReadme(
    owner: string,
    repo: string,
    ctx: GitHubRequestContext = {},
  ): Promise<{ text: string; path?: string }> {
    this.assertSafeOwnerRepo(owner, repo);
    try {
      const res = await this.http.request<{
        content?: string;
        encoding?: string;
        size?: number;
        path?: string;
      }>('GET', `/repos/${owner}/${repo}/readme`, {
        ctx,
        resourceHint: 'core',
        useEtag: true,
      });
      const data = res.data;
      if (!data.content || data.encoding !== 'base64') return { text: '' };
      if ((data.size || 0) > this.maxFileBytes) return { text: '' };
      const text = Buffer.from(data.content, 'base64')
        .toString('utf8')
        .slice(0, this.maxFileBytes);
      return { text, path: data.path };
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'NOT_FOUND')
        return { text: '' };
      if (isGitHubClientError(error) && !error.retryable) return { text: '' };
      throw error;
    }
  }

  /**
   * Recent commits reachable from `sha` (branch name or commit SHA).
   * Used to look for secrets committed and later removed — content analysis
   * of the current tree alone never sees those. Also carries each commit's
   * message and author name — already present on this same API response,
   * so brand-match evidence can check commit history too without any extra
   * requests.
   */
  async listRecentCommits(
    owner: string,
    repo: string,
    sha: string,
    perPage = 15,
    ctx: GitHubRequestContext = {},
  ): Promise<Array<{ sha: string; message: string; authorName: string }>> {
    this.assertSafeOwnerRepo(owner, repo);
    if (!/^[A-Za-z0-9_.\-/]{1,100}$/.test(sha)) return [];
    try {
      const res = await this.http.request<
        Array<{
          sha: string;
          commit?: { message?: string; author?: { name?: string } };
        }>
      >('GET', `/repos/${owner}/${repo}/commits`, {
        params: { sha, per_page: Math.min(perPage, 30) },
        ctx,
        resourceHint: 'core',
        useEtag: false,
      });
      return (res.data || [])
        .filter((c) => c.sha)
        .map((c) => ({
          sha: c.sha,
          message: c.commit?.message || '',
          authorName: c.commit?.author?.name || '',
        }));
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
    // code_search included alongside core/search since it's its own,
    // far stricter quota (10 req/min) - without it here, this bucket
    // silently exhausting was invisible on the status dashboard even
    // though it's the most common cause of a scan stalling near completion.
    const resources: GitHubResource[] = ['core', 'search', 'code_search'];
    const primary: GitHubRateLimitStatus['primary'] = {};
    for (const resource of resources) {
      primary[resource] = await this.store.getSnapshot(scope, resource);
    }

    const thresholds = this.http.getThresholds();
    const pause = await this.store.getAnyPause(scope);
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

  getScanPausedUntil(scanJobId: string) {
    return this.store.getScanPausedUntil(scanJobId);
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
