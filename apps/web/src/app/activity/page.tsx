'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Select,
  SeverityBadge,
  TableSkeleton,
} from '@/components/ui';
import { api, Brand, RecentRepositoryChanges } from '@/lib/api';
import { formatDateTime } from '@/lib/date';

const DAY_OPTIONS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

const LIMIT = 100;

export default function ActivityPage() {
  const [days, setDays] = useState('7');
  const [brandId, setBrandId] = useState('');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [data, setData] = useState<RecentRepositoryChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Brand[]>('/brands').then(setBrands).catch(() => undefined);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ days, limit: String(LIMIT) });
    if (brandId) params.set('brandId', brandId);
    api<RecentRepositoryChanges>(`/scans/repositories/recent-changes?${params}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load recent activity'))
      .finally(() => setLoading(false));
  }, [days, brandId]);

  return (
    <RequireAuth>
      <AppShell title="Recent Activity">
        <Card className="mb-6 flex flex-wrap items-end gap-3 p-4">
          <Field label="Time window">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              {DAY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Company">
            <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">All companies</option>
              {brands.map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </Card>

        {error ? <ErrorState message={error} onRetry={() => setDays((d) => d)} /> : null}
        {loading ? <TableSkeleton rows={6} cols={3} /> : null}

        {!loading && !error && data ? (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <div>
              <h3 className="mb-3 text-sm font-semibold text-[var(--muted)]">
                Recently pushed on GitHub
                <span className="ml-1.5 font-normal text-[var(--muted)]">
                  ({data.recentPushes.length})
                </span>
              </h3>
              {data.recentPushes.length === 0 ? (
                <EmptyState
                  title="No recent pushes"
                  body="No tracked repository was pushed to on GitHub within this window."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.recentPushes.map((repo) => (
                    <li key={repo._id}>
                      <Card className="p-3">
                        <a
                          href={repo.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate font-medium text-[var(--accent)] hover:underline"
                        >
                          {repo.fullName}
                        </a>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
                          <span>Pushed {formatDateTime(repo.githubPushedAt)}</span>
                          {repo.language ? <span>{repo.language}</span> : null}
                          {typeof repo.stars === 'number' ? <span>★ {repo.stars}</span> : null}
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3
                className="mb-3 text-sm font-semibold text-[var(--muted)]"
                title="A rescan just found something new, or something previously marked resolved came back - independent of how recently the code itself changed."
              >
                New / reopened findings
                <span className="ml-1.5 font-normal text-[var(--muted)]">
                  ({data.recentFindingChanges.length})
                </span>
              </h3>
              {data.recentFindingChanges.length === 0 ? (
                <EmptyState
                  title="No new or reopened findings"
                  body="Nothing was newly flagged or came back from resolved within this window."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.recentFindingChanges.map((f) => (
                    <li key={f.findingId}>
                      <Card className="p-3">
                        <Link
                          href={`/findings/${f.findingId}`}
                          className="block truncate font-medium text-[var(--accent)] hover:underline"
                        >
                          {f.repository.fullName}
                        </Link>
                        {f.summary ? (
                          <p className="mt-0.5 truncate text-xs text-[var(--muted)]" title={f.summary}>
                            {f.summary}
                          </p>
                        ) : null}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge tone={f.changeType === 'new' ? 'accent' : 'warning'} className="shrink-0">
                            {f.changeType === 'new' ? 'New' : 'Reopened'}
                          </Badge>
                          <SeverityBadge severity={f.severity} />
                          {f.brandName ? (
                            <span className="text-xs text-[var(--muted)]">{f.brandName}</span>
                          ) : null}
                          <span className="text-xs text-[var(--muted)]">
                            {formatDateTime(f.lastSeenAt)}
                          </span>
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
