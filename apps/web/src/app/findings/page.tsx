'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { EmptyState, LoadingBlock, Pagination, SeverityBadge } from '@/components/ui';
import { api, Finding, Paginated, Repository } from '@/lib/api';

function statusLabel(status?: string) {
  switch (status) {
    case 'acknowledged':
      return 'Acknowledged';
    case 'resolved':
      return 'Resolved';
    case 'false_positive':
      return 'False positive';
    default:
      return 'Open';
  }
}

// Findings are discovered in the past, so presets only look backward from now.
function dateRangeBounds(preset: string): { from?: string; to?: string } {
  const now = new Date();
  switch (preset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    case '7d': {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    case '30d': {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    default:
      return {};
  }
}

export default function FindingsPage() {
  const [data, setData] = useState<Paginated<Finding> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [brand, setBrand] = useState('');
  const [dateRange, setDateRange] = useState('');
  const [page, setPage] = useState(1);

  async function load(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: '10',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
      if (search) params.set('search', search);
      if (severity) params.set('severity', severity);
      if (category) params.set('category', category);
      if (status) params.set('status', status);
      if (brand) params.set('brand', brand);
      const { from, to } = dateRangeBounds(dateRange);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await api<Paginated<Finding>>(`/findings?${params}`);
      setData(res);
      setPage(nextPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load findings');
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
      <AppShell title="Findings" subtitle="Search, filter, and triage detected threats.">
        <form
          onSubmit={onFilter}
          className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <input
            aria-label="Search"
            placeholder="Search summary or brand"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          />
          <select
            aria-label="Severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="false_positive">False positive</option>
          </select>
          <select
            aria-label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          >
            <option value="">All categories</option>
            <option value="exposed_secret">Exposed secret</option>
            <option value="brand_impersonation">Brand impersonation</option>
            <option value="phishing">Phishing</option>
            <option value="fake_apk">Fake APK</option>
            <option value="malware">Malware</option>
            <option value="suspicious_repo">Suspicious repo</option>
          </select>
          <input
            aria-label="Brand"
            placeholder="Brand filter"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          />
          <select
            aria-label="Date range"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          >
            <option value="">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <button
            type="submit"
            className="rounded-md bg-[var(--accent-dim)] px-3 py-2 text-white hover:bg-[var(--accent-hover)]"
          >
            Apply filters
          </button>
        </form>

        {loading ? <LoadingBlock /> : null}
        {error ? <p className="text-[var(--danger)]">{error}</p> : null}

        {!loading && data && data.data.length === 0 ? (
          <EmptyState
            title="No findings match"
            body="Try clearing filters, seeding demo data, or running a manual scan."
          />
        ) : null}

        {data && data.data.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full text-sm">
              <thead className="bg-[var(--bg-elevated)] text-left text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Repository</th>
                  <th className="px-4 py-3 font-medium">Brand</th>
                  <th className="px-4 py-3 font-medium">Severity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Score</th>
                  <th className="px-4 py-3 font-medium">Categories</th>
                  <th className="px-4 py-3 font-medium">Discovered</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((f) => {
                  const repo = f.repositoryId as Repository | undefined;
                  return (
                    <tr key={f._id} className="border-t border-[var(--border)]">
                      <td className="px-4 py-3">
                        <Link href={`/findings/${f._id}`} className="hover:text-[var(--accent)]">
                          {repo?.fullName || f.summary}
                        </Link>
                        {f.isDemo ? (
                          <span className="ml-2 text-xs text-[var(--warning)]">DEMO</span>
                        ) : null}
                        {f.lastChangeType === 'reopened' ? (
                          <span className="ml-2 text-xs text-[var(--high)] border border-[var(--high)]/40 px-1.5 py-0.5 rounded">
                            REOPENED
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">{f.brandName || '—'}</td>
                      <td className="px-4 py-3">
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {statusLabel(f.status)}
                      </td>
                      <td className="px-4 py-3 font-[family-name:var(--font-mono)]">
                        {f.riskScore}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {f.categories?.map((c) => c.replace(/_/g, ' ')).join(', ')}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)] whitespace-nowrap">
                        {f.createdAt ? new Date(f.createdAt).toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
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
