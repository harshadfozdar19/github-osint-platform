'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  TableSkeleton,
} from '@/components/ui';
import { api, GitHubSearchResult, Keyword } from '@/lib/api';
import clsx from 'clsx';

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
  // Separate from `error` (result of running a search) - covers the
  // keyword list fetched once on mount, so a failure there is visible
  // instead of looking identical to "you have no keywords configured".
  const [loadError, setLoadError] = useState('');

  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);

  useEffect(() => setJumpPage(String(page)), [page]);

  useEffect(() => {
    api<Keyword[]>('/keywords')
      .then((res) => setKeywords(res.filter((k) => k.enabled)))
      .catch(() => setLoadError('Failed to load your keywords - the picker below may be empty.'));
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
      <AppShell title="Custom GitHub search">
        <Card className="mb-6 p-4">
          <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
            <Field label="Query" className="min-w-[240px] flex-1">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='e.g. phonepe apk in:name OR filename:.env AKIA'
              />
            </Field>
            <Field label="Type">
              <Select value={type} onChange={(e) => setType(e.target.value as 'repositories' | 'code')}>
                <option value="repositories">Repositories</option>
                <option value="code">Code</option>
              </Select>
            </Field>
            {type === 'repositories' ? (
              <>
                <Field label="Created from">
                  <Input type="date" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} />
                </Field>
                <Field label="Created to">
                  <Input type="date" value={createdTo} onChange={(e) => setCreatedTo(e.target.value)} />
                </Field>
              </>
            ) : null}
            <label className="flex items-center gap-2 pb-2.5 text-sm">
              <Checkbox checked={includeSeen} onChange={(e) => setIncludeSeen(e.target.checked)} />
              Include already-reviewed repos
            </label>
            <Button type="submit" loading={loading}>
              {loading ? 'Searching…' : 'Search'}
            </Button>
          </form>
        </Card>

        {keywords.length > 0 ? (
          <Card className="mb-6 p-4">
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
                    className={clsx(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150',
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                        : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--bg-subtle)]',
                    )}
                    title={kw.category}
                  >
                    {kw.keyword}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                onClick={applyKeywordsToQuery}
                disabled={selectedKeywords.length === 0}
              >
                Apply {selectedKeywords.length > 0 ? `(${selectedKeywords.length})` : ''} to query
              </Button>
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
          </Card>
        ) : null}

        {error ? <ErrorState message={error} /> : null}
        {loadError ? <ErrorState message={loadError} /> : null}
        {loading ? <TableSkeleton rows={4} cols={3} /> : null}

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
                  <Card
                    key={`${item.id}-${item.path || item.full_name}`}
                    as="li"
                    hoverable
                    className="p-4"
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
                  </Card>
                );
              })}
            </ul>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => runSearch(page - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-[var(--muted)]">Page {page}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading || results.items.length < 10}
                onClick={() => runSearch(page + 1)}
              >
                Next
              </Button>
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
                <Input
                  id="search-page-jump"
                  type="number"
                  min={1}
                  value={jumpPage}
                  onChange={(e) => setJumpPage(e.target.value)}
                  className="w-16 py-1.5"
                />
                <Button type="submit" variant="outline" size="sm" disabled={loading}>
                  Go
                </Button>
              </form>
            </div>
          </>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
