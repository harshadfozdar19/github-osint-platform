'use client';

import { FormEvent, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
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
  Modal,
  Pagination,
  Select,
  TableSkeleton,
} from '@/components/ui';
import { api, Brand, ContributorSummary, Paginated } from '@/lib/api';

// How many repo chips to show inline before collapsing the rest behind an
// overflow indicator - keeps every row a fixed height regardless of how many
// repos a contributor touches (some show up on 30+).
const VISIBLE_REPOS = 3;

function RepoChip({ fullName, company }: { fullName: string; company?: string }) {
  return (
    <a
      href={`https://github.com/${fullName}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--muted)] hover:text-[var(--accent)] hover:underline"
      title={company ? `${fullName} (${company})` : fullName}
    >
      {fullName}
    </a>
  );
}

function RepoList({ contributor }: { contributor: ContributorSummary }) {
  const [showAll, setShowAll] = useState(false);
  const visible = contributor.repositories.slice(0, VISIBLE_REPOS);
  const hidden = contributor.repositories.slice(VISIBLE_REPOS);
  return (
    <>
      <div className="flex flex-wrap items-center gap-1 max-w-[320px]">
        {visible.map((r) => (
          <RepoChip key={r.repositoryId} fullName={r.fullName} company={r.company} />
        ))}
        {hidden.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="inline-flex items-center rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--muted)] hover:text-[var(--accent)] hover:border-[var(--accent-border)]"
            title={`Show all ${contributor.repositories.length} repositories`}
          >
            &hellip;
          </button>
        ) : null}
      </div>
      {showAll ? (
        <Modal
          title={`${contributor.login} — ${contributor.repositories.length} repositories`}
          onClose={() => setShowAll(false)}
        >
          <div className="flex flex-wrap gap-1.5">
            {contributor.repositories.map((r) => (
              <RepoChip key={r.repositoryId} fullName={r.fullName} company={r.company} />
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

export default function ContributorsPage() {
  const [data, setData] = useState<Paginated<ContributorSummary> | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [minRepositories, setMinRepositories] = useState('');
  const [sortBy, setSortBy] = useState<'totalRepositories' | 'login'>('totalRepositories');
  const [page, setPage] = useState(1);

  useEffect(() => {
    api<Brand[]>('/brands')
      .then(setBrands)
      .catch(() => setBrands([]));
  }, []);

  async function load(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: '20',
        sortBy,
      });
      if (search) params.set('search', search);
      if (companyId) params.set('companyId', companyId);
      if (minRepositories) params.set('minRepositories', minRepositories);
      const res = await api<Paginated<ContributorSummary>>(`/contributors?${params}`);
      setData(res);
      setPage(nextPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contributors');
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

  return (
    <RequireAuth>
      <AppShell title="Contributors">
        <Card className="mb-6 p-4">
          <form onSubmit={onFilter} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Search">
              <Input
                placeholder="GitHub login"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
            <Field label="Company">
              <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">All companies</option>
                {brands.map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Repositories">
              <Select
                value={minRepositories}
                onChange={(e) => setMinRepositories(e.target.value)}
                title="Only contributors active on at least this many distinct repos in this workspace"
              >
                <option value="">All</option>
                <option value="2">2 or more (shared)</option>
                <option value="3">3 or more</option>
                <option value="5">5 or more</option>
              </Select>
            </Field>
            <Field label="Sort by">
              <Select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'totalRepositories' | 'login')}
              >
                <option value="totalRepositories">Most repositories first</option>
                <option value="login">Login (A-Z)</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" className="w-full">
                Apply filters
              </Button>
            </div>
          </form>
        </Card>

        {loading ? <TableSkeleton rows={6} cols={4} /> : null}
        {error ? <ErrorState message={error} onRetry={() => load()} /> : null}

        {!loading && data && data.data.length === 0 ? (
          <EmptyState
            title="No contributors match"
            body="Contributors are recorded during deep analysis - try clearing filters, or check back once more repos have been analyzed."
          />
        ) : null}

        {data && data.data.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)]">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-[var(--bg-subtle)] text-left text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Contributor</th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Total repos</th>
                  <th className="px-4 py-3 font-medium">Companies</th>
                  <th className="px-4 py-3 font-medium">Repositories</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((c) => (
                  <tr
                    key={c.login}
                    className="border-t border-[var(--border)] transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
                  >
                    <td className="px-4 py-3">
                      <a
                        href={`https://github.com/${c.login}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 font-medium hover:text-[var(--accent)]"
                      >
                        {c.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.avatarUrl}
                            alt=""
                            className="h-5 w-5 rounded-full"
                          />
                        ) : null}
                        {c.login}
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                      </a>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap font-[family-name:var(--font-mono)]">
                      <span
                        className={
                          c.totalRepositories > 1
                            ? 'text-[var(--high)] font-medium'
                            : undefined
                        }
                        title={
                          c.totalRepositories > 1
                            ? 'Contributes to more than one repo in this workspace'
                            : undefined
                        }
                      >
                        {c.totalRepositories}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {c.companies.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {c.companies.map((name) => (
                            <Badge key={name} tone="muted">
                              {name}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <RepoList contributor={c} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {data && data.meta.totalPages > 1 ? (
          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={load} />
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
