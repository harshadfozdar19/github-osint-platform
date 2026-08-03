'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { EmptyState, LoadingBlock } from '@/components/ui';
import { api, GitHubSearchResult, Keyword } from '@/lib/api';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'repositories' | 'code'>('repositories');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [includeSeen, setIncludeSeen] = useState(false);
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const [results, setResults] = useState<GitHubSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);

  useEffect(() => setJumpPage(String(page)), [page]);

  useEffect(() => {
    api<Keyword[]>('/keywords')
      .then((res) => setKeywords(res.filter((k) => k.enabled)))
      .catch(() => setKeywords([]));
  }, []);

  function toggleKeyword(kw: string) {
    setSelectedKeywords((prev) =>
      prev.includes(kw) ? prev.filter((k) => k !== kw) : [...prev, kw],
    );
  }

  function applyKeywordsToQuery() {
    if (selectedKeywords.length === 0) return;
    const group =
      selectedKeywords.length > 1
        ? `(${selectedKeywords.join(' OR ')})`
        : selectedKeywords[0];
    setQuery(type === 'repositories' ? `${group} in:name,description` : group);
  }

  async function runSearch(nextPage = 1) {
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        page: String(nextPage),
        type,
      });
      if (type === 'repositories' && createdFrom) params.set('createdFrom', createdFrom);
      if (type === 'repositories' && createdTo) params.set('createdTo', createdTo);
      if (includeSeen) params.set('includeSeen', 'true');
      const res = await api<GitHubSearchResult>(`/scans/search?${params}`);
      setResults(res);
      setPage(nextPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    runSearch(1);
  }

  return (
    <RequireAuth>
      <AppShell
        title="Custom GitHub search"
        subtitle="Run ad-hoc repository or code searches through the managed GitHub client."
      >
        <form
          onSubmit={onSubmit}
          className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4"
        >
          <label className="flex-1 min-w-[240px] text-sm">
            <span className="mb-1 block text-[var(--muted)]">Query</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              placeholder='e.g. phonepe apk in:name OR filename:.env AKIA'
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'repositories' | 'code')}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
            >
              <option value="repositories">Repositories</option>
              <option value="code">Code</option>
            </select>
          </label>
          {type === 'repositories' ? (
            <>
              <label className="text-sm">
                <span className="mb-1 block text-[var(--muted)]">Created from</span>
                <input
                  type="date"
                  value={createdFrom}
                  onChange={(e) => setCreatedFrom(e.target.value)}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-[var(--muted)]">Created to</span>
                <input
                  type="date"
                  value={createdTo}
                  onChange={(e) => setCreatedTo(e.target.value)}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                />
              </label>
            </>
          ) : null}
          <label className="flex items-center gap-2 text-sm pb-2">
            <input
              type="checkbox"
              checked={includeSeen}
              onChange={(e) => setIncludeSeen(e.target.checked)}
            />
            Include already-reviewed repos
          </label>
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-[var(--accent-dim)] px-4 py-2 text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {keywords.length > 0 ? (
          <div className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4">
            <p className="mb-3 text-sm text-[var(--muted)]">
              Or build a query from your keywords — pick one or more, then
              apply them into the query field above.
            </p>
            <div className="flex flex-wrap gap-2">
              {keywords.map((kw) => {
                const active = selectedKeywords.includes(kw.keyword);
                return (
                  <button
                    key={kw._id}
                    type="button"
                    onClick={() => toggleKeyword(kw.keyword)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-white'
                        : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--bg)]'
                    }`}
                    title={kw.category}
                  >
                    {kw.keyword}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={applyKeywordsToQuery}
                disabled={selectedKeywords.length === 0}
                className="rounded-md bg-[var(--accent-dim)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                Apply {selectedKeywords.length > 0 ? `(${selectedKeywords.length})` : ''} to query
              </button>
              {selectedKeywords.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSelectedKeywords([])}
                  className="text-sm text-[var(--muted)] hover:underline"
                >
                  Clear selection
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {error ? <p className="mb-4 text-[var(--danger)]">{error}</p> : null}
        {loading ? <LoadingBlock label="Querying GitHub…" /> : null}

        {!loading && results && results.items.length === 0 ? (
          <EmptyState
            title="No results"
            body={
              results.hiddenSeenCount
                ? `${results.hiddenSeenCount} repo${results.hiddenSeenCount === 1 ? '' : 's'} matched but ${results.hiddenSeenCount === 1 ? 'was' : 'were'} already reviewed. Check "Include already-reviewed repos" to see them again.`
                : 'Try a different query or search type.'
            }
          />
        ) : null}

        {!loading && results && results.items.length > 0 ? (
          <>
            <p className="mb-4 text-sm text-[var(--muted)]">
              {results.total_count.toLocaleString()} results
              {results.incomplete_results ? ' (incomplete)' : ''} · page {page}
              {results.hiddenSeenCount ? (
                <span> · {results.hiddenSeenCount} already-reviewed repo{results.hiddenSeenCount === 1 ? '' : 's'} hidden</span>
              ) : null}
            </p>
            <ul className="space-y-3">
              {results.items.map((item) => {
                const title =
                  item.full_name ||
                  item.repository?.full_name ||
                  `${item.path || item.name || 'Result'}`;
                const url = item.html_url || item.repository?.html_url || '#';
                return (
                  <li
                    key={`${item.id}-${item.path || item.full_name}`}
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4"
                  >
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[var(--accent)] hover:underline"
                    >
                      {title}
                    </a>
                    {item.path ? (
                      <p className="mt-1 text-xs text-[var(--muted)]">{item.path}</p>
                    ) : null}
                    {item.description ? (
                      <p className="mt-2 text-sm text-[var(--muted)]">{item.description}</p>
                    ) : null}
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      {item.language ? `${item.language} · ` : ''}
                      {item.stargazers_count != null ? `${item.stargazers_count} stars` : ''}
                    </p>
                  </li>
                );
              })}
            </ul>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => runSearch(page - 1)}
                className="rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-[var(--muted)]">Page {page}</span>
              <button
                type="button"
                disabled={loading || results.items.length < 10}
                onClick={() => runSearch(page + 1)}
                className="rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
              >
                Next
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = Math.trunc(Number(jumpPage));
                  if (Number.isFinite(parsed) && parsed >= 1) runSearch(parsed);
                }}
                className="flex items-center gap-2"
              >
                <label htmlFor="search-page-jump" className="text-sm text-[var(--muted)]">
                  Go to page
                </label>
                <input
                  id="search-page-jump"
                  type="number"
                  min={1}
                  value={jumpPage}
                  onChange={(e) => setJumpPage(e.target.value)}
                  className="w-16 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="rounded-md border border-[var(--border)] px-3 py-1 text-sm hover:bg-[var(--bg-elevated)] disabled:opacity-50"
                >
                  Go
                </button>
              </form>
            </div>
          </>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
