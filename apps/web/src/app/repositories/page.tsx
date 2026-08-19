'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Pagination,
  Select,
  SeverityBadge,
  TableSkeleton,
} from '@/components/ui';
import {
  api,
  Brand,
  Paginated,
  RecentRepositoryChanges,
  Repository,
  RepositoryBranch,
} from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/date';

type AnalysisFilter = 'all' | 'pending' | 'analyzed';

/** Same preset-to-range approach as the Findings page's dateRangeBounds - a handful of common windows instead of raw from/to date pickers for every one of the four date-ish columns below (that'd be eight separate inputs). */
function dateRangeBounds(preset: string): { from?: string; to?: string } {
  const now = new Date();
  switch (preset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    case '7d':
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    case '30d':
      return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    default:
      return {};
  }
}

function AnalysisBadge({ repo }: { repo: Repository }) {
  if (repo.pendingAnalysis) {
    return (
      <span title="Discovered but not yet content-analyzed - run 'Analyze discovered repos' on the Scans page.">
        <Badge tone="accent">Pending analysis</Badge>
      </span>
    );
  }
  if (repo.lastProcessingFailed) {
    return <Badge tone="danger">Analysis failed</Badge>;
  }
  return <Badge tone="muted">Analyzed</Badge>;
}

const LOCATION_LABELS: Record<string, string> = {
  owner: 'Account/owner name',
  repo_name: 'Repository name',
  description: 'Description',
  topics: 'Topics',
  file_path: 'File path',
  readme: 'README',
  file_content: 'Code',
  commit_message: 'Commit message',
  commit_author: 'Commit author',
};

function MatchInfo({ repo }: { repo: Repository }) {
  if (!repo.matchedBrand) {
    return <span className="text-[var(--muted)]">—</span>;
  }
  // Not yet content-analyzed AND the discovering scan couldn't tell where
  // from its search response alone (an older discovery from before this was
  // captured, or a full brand sweep with no single keyword to check
  // metadata against) - genuinely nothing more specific to show.
  if (!repo.matchConfirmed && !repo.matchLocation) {
    return (
      <span
        className="text-xs text-[var(--muted)]"
        title="Discovered by a GitHub search scoped to this keyword - not yet content-analyzed, so the exact location within the repo isn't confirmed yet."
      >
        Not yet analyzed
        {repo.matchKeyword ? ` — found via keyword "${repo.matchKeyword}"` : ''}
      </span>
    );
  }
  const locationLabel = repo.matchLocation
    ? LOCATION_LABELS[repo.matchLocation] || repo.matchLocation
    : 'Unknown';
  return (
    <div className="text-xs">
      <span
        title={
          repo.matchConfirmed
            ? undefined
            : "Best-effort location from the discovering search - not yet content-analyzed, so this hasn't been byte-confirmed."
        }
      >
        <Badge tone={repo.matchConfirmed ? 'accent' : 'muted'}>
          {locationLabel}
          {repo.matchFilePath
            ? `: ${repo.matchFilePath}${repo.matchLineNumber ? `:${repo.matchLineNumber}` : ''}`
            : ''}
        </Badge>
      </span>
      {!repo.matchConfirmed ? (
        <span className="ml-1 text-[var(--muted)]">
          (unconfirmed
          {repo.matchKeyword ? ` — keyword "${repo.matchKeyword}"` : ''})
        </span>
      ) : null}
      {repo.matchedText ? (
        <p
          className="mt-0.5 max-w-[14rem] truncate text-[var(--muted)]"
          title={repo.matchedText}
        >
          &quot;{repo.matchedText}&quot;
        </p>
      ) : null}
    </div>
  );
}

export default function RepositoriesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <RepositoriesPageInner />
    </Suspense>
  );
}

function RepositoriesPageInner() {
  const searchParams = useSearchParams();
  // Deep-link from the sequential scheduler's per-keyword "View" - see
  // KeywordScheduleQueue. keywordFilter requires brandFilter alongside it
  // (a keyword string alone isn't unique across companies), matching the
  // backend's own requirement. The Company filter select below shares this
  // same brandFilter state - picking a company from the dropdown is just a
  // less specific version of the same filter this deep-link sets.
  const [brandFilter, setBrandFilter] = useState(searchParams.get('brandId') || '');
  const [brandFilterName, setBrandFilterName] = useState(searchParams.get('brandName') || '');
  const [keywordFilter, setKeywordFilter] = useState(searchParams.get('keyword') || '');
  const [data, setData] = useState<Paginated<Repository> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [analysisFilter, setAnalysisFilter] = useState<AnalysisFilter>('all');
  const [language, setLanguage] = useState('');
  const [matchLocation, setMatchLocation] = useState('');
  const [discoveredRange, setDiscoveredRange] = useState('');
  const [githubCreatedRange, setGithubCreatedRange] = useState('');
  const [githubCreatedFrom, setGithubCreatedFrom] = useState('');
  const [githubCreatedTo, setGithubCreatedTo] = useState('');
  const [pushedRange, setPushedRange] = useState('');
  const [pushedFrom, setPushedFrom] = useState('');
  const [pushedTo, setPushedTo] = useState('');
  const [lastScannedRange, setLastScannedRange] = useState('');
  const [page, setPage] = useState(1);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [recentChanges, setRecentChanges] = useState<RecentRepositoryChanges | null>(null);

  // "Branches" modal - GitHub's search index only ever covers a repo's
  // default branch, so this is the only way to check a side branch a search
  // hit never surfaced. branchesRepo is which row's modal is open (null =
  // closed); branches/branchesLoading/branchesError track that fetch;
  // analyzingBranch tracks which single branch's "Analyze" button is
  // currently submitting, so only that one shows a spinner.
  const [branchesRepo, setBranchesRepo] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<RepositoryBranch[] | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState('');
  const [analyzingBranch, setAnalyzingBranch] = useState<string | null>(null);

  function openBranches(repo: Repository) {
    setBranchesRepo(repo);
    setBranches(null);
    setBranchesError('');
    setBranchesLoading(true);
    api<RepositoryBranch[]>(`/scans/repositories/${repo._id}/branches`)
      .then(setBranches)
      .catch((err) =>
        setBranchesError(err instanceof Error ? err.message : 'Failed to load branches'),
      )
      .finally(() => setBranchesLoading(false));
  }

  async function analyzeBranch(branch: string) {
    if (!branchesRepo) return;
    setAnalyzingBranch(branch);
    setBranchesError('');
    try {
      const job = await api<{ _id: string }>(
        `/scans/repositories/${branchesRepo._id}/branches/analyze`,
        { method: 'POST', body: JSON.stringify({ branch }) },
      );
      window.location.href = `/scans/${job._id}`;
    } catch (err) {
      setBranchesError(err instanceof Error ? err.message : 'Failed to start branch analysis');
      setAnalyzingBranch(null);
    }
  }

  useEffect(() => {
    api<Brand[]>('/brands').then(setBrands).catch(() => undefined);
    api<string[]>('/scans/repositories/languages').then(setLanguages).catch(() => undefined);
    api<RecentRepositoryChanges>('/scans/repositories/recent-changes?days=7&limit=8')
      .then(setRecentChanges)
      .catch(() => undefined);
  }, []);

  function buildParams(
    nextPage: number,
    overrides: { brandFilter?: string; keywordFilter?: string } = {},
  ) {
    const params = new URLSearchParams({ page: String(nextPage), limit: '20' });
    if (search.trim()) params.set('search', search.trim());
    if (analysisFilter === 'pending') params.set('pendingAnalysis', 'true');
    if (analysisFilter === 'analyzed') params.set('pendingAnalysis', 'false');
    const effectiveBrand = overrides.brandFilter ?? brandFilter;
    const effectiveKeyword = overrides.keywordFilter ?? keywordFilter;
    if (effectiveBrand) params.set('brandId', effectiveBrand);
    if (effectiveKeyword) params.set('keyword', effectiveKeyword);
    if (language) params.set('language', language);
    if (matchLocation) params.set('matchLocation', matchLocation);
    const discovered = dateRangeBounds(discoveredRange);
    if (discovered.from) params.set('discoveredFrom', discovered.from);
    if (discovered.to) params.set('discoveredTo', discovered.to);
    if (githubCreatedRange === 'custom') {
      // "From" as-is (YYYY-MM-DD parses as that day's UTC midnight, already
      // inclusive of the whole day going forward). "To" needs the end of
      // that same day appended, or a bare date would only include results
      // up to midnight AT THE START of it, excluding the rest of that day.
      if (githubCreatedFrom) params.set('githubCreatedFrom', githubCreatedFrom);
      if (githubCreatedTo) params.set('githubCreatedTo', `${githubCreatedTo}T23:59:59.999Z`);
    } else {
      const githubCreated = dateRangeBounds(githubCreatedRange);
      if (githubCreated.from) params.set('githubCreatedFrom', githubCreated.from);
      if (githubCreated.to) params.set('githubCreatedTo', githubCreated.to);
    }
    if (pushedRange === 'custom') {
      if (pushedFrom) params.set('pushedFrom', pushedFrom);
      if (pushedTo) params.set('pushedTo', `${pushedTo}T23:59:59.999Z`);
    } else {
      const pushed = dateRangeBounds(pushedRange);
      if (pushed.from) params.set('pushedFrom', pushed.from);
      if (pushed.to) params.set('pushedTo', pushed.to);
    }
    const lastScanned = dateRangeBounds(lastScannedRange);
    if (lastScanned.from) params.set('lastScannedFrom', lastScanned.from);
    if (lastScanned.to) params.set('lastScannedTo', lastScanned.to);
    return params;
  }

  async function load(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const params = buildParams(nextPage);
      const res = await api<Paginated<Repository>>(`/scans/repositories?${params}`);
      setData(res);
      setPage(nextPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onFilter(e: FormEvent) {
    e.preventDefault();
    load(1);
  }

  function onCompanyChange(id: string) {
    // A manually-picked company invalidates any keyword-scoped deep-link
    // context (that keyword belonged to whichever company the link named,
    // not necessarily this one) - clear it rather than leave a stale,
    // mismatched keyword filter silently attached to the new company.
    setBrandFilter(id);
    setBrandFilterName('');
    setKeywordFilter('');
  }

  function clearKeywordFilter() {
    setBrandFilter('');
    setBrandFilterName('');
    setKeywordFilter('');
    setLoading(true);
    setError('');
    const params = buildParams(1, { brandFilter: '', keywordFilter: '' });
    api<Paginated<Repository>>(`/scans/repositories?${params}`)
      .then((res) => {
        setData(res);
        setPage(1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load repositories'))
      .finally(() => setLoading(false));
  }

  return (
    <RequireAuth>
      <AppShell
        title="Repositories"
        subtitle="Every repository a keyword/GitHub search has discovered - both ones already content-analyzed and ones still waiting on 'Analyze discovered repos'. Sorted newest-discovered first. Internal audit repos (enumerated directly from a company's own trusted GitHub accounts) aren't keyword discoveries and appear on that scan's own progress page instead."
      >
        {keywordFilter ? (
          <div
            className="mb-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)' }}
          >
            <span>
              Filtered to keyword <strong className="font-[family-name:var(--font-mono)]">{keywordFilter}</strong>
              {brandFilterName ? ` — ${brandFilterName}` : ''}
            </span>
            <button
              type="button"
              onClick={clearKeywordFilter}
              className="ml-auto text-xs font-medium text-[var(--accent)] hover:underline"
            >
              Clear filter
            </button>
          </div>
        ) : null}

        <div className="xl:grid xl:grid-cols-[1fr_320px] xl:items-start xl:gap-6">
          <div className="min-w-0">
            <Card className="mb-6 p-4">
              <form onSubmit={onFilter} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Repository name">
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="owner/repo…"
                  />
                </Field>
                <Field label="Company">
                  <Select value={brandFilter} onChange={(e) => onCompanyChange(e.target.value)}>
                    <option value="">All companies</option>
                    {brands.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Match found in">
                  <Select value={matchLocation} onChange={(e) => setMatchLocation(e.target.value)}>
                    <option value="">Anywhere</option>
                    {Object.entries(LOCATION_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Language">
                  <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="">All languages</option>
                    {languages.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Status">
                  <Select
                    value={analysisFilter}
                    onChange={(e) => setAnalysisFilter(e.target.value as AnalysisFilter)}
                  >
                    <option value="all">All</option>
                    <option value="pending">Pending analysis</option>
                    <option value="analyzed">Analyzed</option>
                  </Select>
                </Field>
                <Field label="Discovered">
                  <Select
                    value={discoveredRange}
                    onChange={(e) => setDiscoveredRange(e.target.value)}
                    title="When WE first found this repo, not any GitHub timestamp."
                  >
                    <option value="">All time</option>
                    <option value="today">Today</option>
                    <option value="7d">Last 7 days</option>
                    <option value="30d">Last 30 days</option>
                  </Select>
                </Field>
                <Field label="GitHub created">
                  <Select
                    value={githubCreatedRange}
                    onChange={(e) => setGithubCreatedRange(e.target.value)}
                    title="When this repo was created on GitHub."
                  >
                    <option value="">All time</option>
                    <option value="today">Today</option>
                    <option value="7d">Last 7 days</option>
                    <option value="30d">Last 30 days</option>
                    <option value="custom">Custom range…</option>
                  </Select>
                </Field>
                {githubCreatedRange === 'custom' ? (
                  <Field label="Created from / to" className="sm:col-span-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="date"
                        value={githubCreatedFrom}
                        onChange={(e) => setGithubCreatedFrom(e.target.value)}
                        className="min-w-0 flex-1"
                      />
                      <span className="shrink-0 text-[var(--muted)]">to</span>
                      <Input
                        type="date"
                        value={githubCreatedTo}
                        onChange={(e) => setGithubCreatedTo(e.target.value)}
                        className="min-w-0 flex-1"
                      />
                    </div>
                  </Field>
                ) : null}
                <Field label="Last pushed">
                  <Select
                    value={pushedRange}
                    onChange={(e) => setPushedRange(e.target.value)}
                    title="Most recent commit/push to this repo on GitHub."
                  >
                    <option value="">All time</option>
                    <option value="today">Today</option>
                    <option value="7d">Last 7 days</option>
                    <option value="30d">Last 30 days</option>
                    <option value="custom">Custom range…</option>
                  </Select>
                </Field>
                {pushedRange === 'custom' ? (
                  <Field label="Pushed from / to" className="sm:col-span-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="date"
                        value={pushedFrom}
                        onChange={(e) => setPushedFrom(e.target.value)}
                        className="min-w-0 flex-1"
                      />
                      <span className="shrink-0 text-[var(--muted)]">to</span>
                      <Input
                        type="date"
                        value={pushedTo}
                        onChange={(e) => setPushedTo(e.target.value)}
                        className="min-w-0 flex-1"
                      />
                    </div>
                  </Field>
                ) : null}
                <Field label="Last scanned">
                  <Select
                    value={lastScannedRange}
                    onChange={(e) => setLastScannedRange(e.target.value)}
                    title="When our own last analysis pass ran on this repo."
                  >
                    <option value="">All time</option>
                    <option value="today">Today</option>
                    <option value="7d">Last 7 days</option>
                    <option value="30d">Last 30 days</option>
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Button type="submit" className="w-full">
                    Apply filters
                  </Button>
                </div>
              </form>
            </Card>

            {!loading && data ? (
              <p className="mb-3 text-sm text-[var(--muted)]">
                <span className="font-semibold text-[var(--text)]">{data.meta.total}</span>{' '}
                repositor{data.meta.total === 1 ? 'y' : 'ies'} found matching the current filters
              </p>
            ) : null}
            {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
            {loading ? <TableSkeleton rows={6} cols={6} /> : null}
            {!loading && data && data.data.length === 0 ? (
              <EmptyState
                title="No repositories discovered yet"
                body="Run a scan from the Scans page - repos it finds (analyzed or still pending) will show up here."
              />
            ) : null}
            {data && data.data.length > 0 ? (
              <>
                <div className="overflow-x-auto rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)]">
                  <table className="min-w-[1000px] w-full text-sm">
                    <thead className="bg-[var(--bg-subtle)] text-left text-[var(--muted)]">
                      <tr>
                        <th className="px-4 py-3">Repository</th>
                        <th className="px-4 py-3">Company</th>
                        <th className="px-4 py-3">Match found in</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Language</th>
                        <th className="px-4 py-3">Stars</th>
                        <th className="px-4 py-3">Discovered</th>
                        <th className="px-4 py-3">GitHub created</th>
                        <th className="px-4 py-3">Last pushed</th>
                        <th className="px-4 py-3">Last scanned</th>
                        <th className="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                  {data.data.map((repo) => (
                    <tr
                      key={repo._id}
                      className="border-t border-[var(--border)] transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
                    >
                      <td className="px-4 py-3">
                        <a
                          href={repo.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-[var(--accent)] hover:underline"
                        >
                          {repo.fullName}
                        </a>
                        {repo.description ? (
                          <p className="mt-0.5 max-w-md truncate text-xs text-[var(--muted)]">
                            {repo.description}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-medium">
                        {repo.matchedBrand || '—'}
                        {repo.additionalBrands && repo.additionalBrands.length > 0 ? (
                          <p
                            className="mt-0.5 text-xs font-normal text-[var(--muted)]"
                            title={`This repo also matched: ${repo.additionalBrands
                              .map((b) => (b.keyword ? `${b.name} (keyword "${b.keyword}")` : b.name))
                              .join(', ')}`}
                          >
                            Also: {repo.additionalBrands.map((b) => b.name).join(', ')}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <MatchInfo repo={repo} />
                      </td>
                      <td className="px-4 py-3">
                        <AnalysisBadge repo={repo} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                        {repo.language || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{repo.stars}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                        {formatDateTime(repo.createdAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                        {formatDate(repo.githubCreatedAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                        {formatDate(repo.githubPushedAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                        {formatDate(repo.lastScannedAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openBranches(repo)}
                        >
                          Branches
                        </Button>
                      </td>
                    </tr>
                  ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={load} />
              </>
            ) : null}
          </div>

          {recentChanges &&
          (recentChanges.recentPushes.length > 0 ||
            recentChanges.recentFindingChanges.length > 0) ? (
            <div className="mt-6 xl:mt-0">
              <Card className="p-4">
                <h3 className="mb-3 text-sm font-semibold text-[var(--muted)]">
                  Recent changes (last 7 days)
                </h3>
                <div className="space-y-4">
                  <div>
                    <p className="mb-2 text-xs font-medium text-[var(--muted)]">
                      Recently pushed on GitHub
                    </p>
                    {recentChanges.recentPushes.length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">No recent pushes.</p>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {recentChanges.recentPushes.map((repo) => (
                          <li
                            key={repo._id}
                            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
                          >
                            <a
                              href={repo.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate font-medium text-[var(--accent)] hover:underline"
                            >
                              {repo.fullName}
                            </a>
                            <span className="text-xs text-[var(--muted)]">
                              {formatDateTime(repo.githubPushedAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p
                      className="mb-2 text-xs font-medium text-[var(--muted)]"
                      title="A rescan just found something new, or something previously marked resolved came back - independent of how recently the code itself changed."
                    >
                      New / reopened findings
                    </p>
                    {recentChanges.recentFindingChanges.length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">No new or reopened findings.</p>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {recentChanges.recentFindingChanges.map((f) => (
                          <li
                            key={f.findingId}
                            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
                          >
                            <Link
                              href={`/findings/${f.findingId}`}
                              className="block truncate font-medium text-[var(--accent)] hover:underline"
                            >
                              {f.repository.fullName}
                            </Link>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <Badge
                                tone={f.changeType === 'new' ? 'accent' : 'warning'}
                                className="shrink-0"
                              >
                                {f.changeType === 'new' ? 'New' : 'Reopened'}
                              </Badge>
                              <SeverityBadge severity={f.severity} />
                              <span className="text-xs text-[var(--muted)]">
                                {formatDateTime(f.lastSeenAt)}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </Card>
            </div>
          ) : null}
        </div>

        {branchesRepo ? (
          <Modal title={`Branches — ${branchesRepo.fullName}`} onClose={() => setBranchesRepo(null)}>
            <p className="mb-3 text-xs text-[var(--muted)]">
              GitHub&apos;s search index only ever covers the default branch - analyzing a side
              branch clones and scans it directly, on demand.
            </p>
            {branchesError ? (
              <p className="mb-3 text-sm text-[var(--danger)]">{branchesError}</p>
            ) : null}
            {branchesLoading ? (
              <LoadingBlock label="Loading branches…" />
            ) : branches && branches.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {branches.map((b) => (
                  <li
                    key={b.name}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{b.name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        {b.isDefault ? <Badge tone="muted">Default</Badge> : null}
                        {b.protected ? <Badge tone="muted">Protected</Badge> : null}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      loading={analyzingBranch === b.name}
                      disabled={analyzingBranch !== null && analyzingBranch !== b.name}
                      onClick={() => analyzeBranch(b.name)}
                    >
                      Analyze
                    </Button>
                  </li>
                ))}
              </ul>
            ) : branches ? (
              <p className="text-sm text-[var(--muted)]">No branches found.</p>
            ) : null}
          </Modal>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
