'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { EmptyState, LoadingBlock } from '@/components/ui';
import { api, Brand, Paginated, ScanJob } from '@/lib/api';

type ScanModeOption = 'incremental' | 'full' | 'failed_only';
type ScopeOption = 'all' | 'brand' | 'query';

export default function ScansPage() {
  const [data, setData] = useState<Paginated<ScanJob> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<ScanModeOption>('incremental');
  const [forceFullScan, setForceFullScan] = useState(false);
  const [scope, setScope] = useState<ScopeOption>('all');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandId, setBrandId] = useState('');
  const [customQuery, setCustomQuery] = useState('');
  const [searchKind, setSearchKind] = useState<'repositories' | 'code'>('repositories');
  const [maxRepos, setMaxRepos] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await api<Paginated<ScanJob>>('/scans?limit=20');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scans');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    api<Brand[]>('/brands')
      .then((res) => setBrands(res))
      .catch(() => undefined);
  }, []);

  async function startManual() {
    if (scope === 'brand' && !brandId) {
      setError('Pick a brand to scope this scan to.');
      return;
    }
    if (scope === 'query' && !customQuery.trim()) {
      setError('Enter a GitHub search query to scope this scan to.');
      return;
    }
    setRunning(true);
    setMessage('');
    setError('');
    try {
      const parsedMaxRepos = Number(maxRepos);
      const job = await api<ScanJob>('/scans/manual', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          forceFullScan: mode === 'full' ? true : forceFullScan,
          ...(scope === 'brand' ? { brandId } : {}),
          ...(scope === 'query' ? { customQuery: customQuery.trim(), searchKind } : {}),
          ...(mode !== 'failed_only' && maxRepos.trim() && Number.isFinite(parsedMaxRepos)
            ? { maxRepos: parsedMaxRepos }
            : {}),
        }),
      });
      setMessage(`Scan accepted (${job.status}, mode=${job.mode || mode}). Opening live progress…`);
      window.location.href = `/scans/${job._id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
      setRunning(false);
    }
  }

  return (
    <RequireAuth>
      <AppShell
        title="Scans"
        subtitle="Incremental by default: unchanged repositories skip content analysis. Modes: incremental, full rescan, failed items only."
      >
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">Scan mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as ScanModeOption)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
            >
              <option value="incremental">Incremental (skip unchanged)</option>
              <option value="full">Full rescan</option>
              <option value="failed_only">Failed items only</option>
            </select>
          </label>
          {mode === 'incremental' ? (
            <label className="flex items-center gap-2 text-sm pb-2">
              <input
                type="checkbox"
                checked={forceFullScan}
                onChange={(e) => setForceFullScan(e.target.checked)}
              />
              Force full content scan
            </label>
          ) : null}
          {mode !== 'failed_only' ? (
            <label className="text-sm">
              <span className="mb-1 block text-[var(--muted)]">Scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as ScopeOption)}
                className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              >
                <option value="all">All enabled brands</option>
                <option value="brand">One brand</option>
                <option value="query">Custom GitHub query</option>
              </select>
            </label>
          ) : null}
          {mode !== 'failed_only' && scope === 'brand' ? (
            <label className="text-sm">
              <span className="mb-1 block text-[var(--muted)]">Brand</span>
              <select
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              >
                <option value="">Select a brand…</option>
                {brands.map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {mode !== 'failed_only' && scope === 'query' ? (
            <>
              <label className="text-sm min-w-[240px] flex-1">
                <span className="mb-1 block text-[var(--muted)]">GitHub query</span>
                <input
                  value={customQuery}
                  onChange={(e) => setCustomQuery(e.target.value)}
                  placeholder='e.g. phonepe apk in:name'
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-[var(--muted)]">Search kind</span>
                <select
                  value={searchKind}
                  onChange={(e) => setSearchKind(e.target.value as 'repositories' | 'code')}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                >
                  <option value="repositories">Repositories</option>
                  <option value="code">Code</option>
                </select>
              </label>
            </>
          ) : null}
          {mode !== 'failed_only' ? (
            <label className="text-sm">
              <span className="mb-1 block text-[var(--muted)]">Max repos</span>
              <input
                type="number"
                min={1}
                value={maxRepos}
                onChange={(e) => setMaxRepos(e.target.value)}
                placeholder="Default"
                className="w-28 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              />
            </label>
          ) : null}
          <button
            type="button"
            onClick={startManual}
            disabled={running}
            className="rounded-md bg-[var(--accent-dim)] px-4 py-2 text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            {running ? 'Enqueueing…' : 'Start scan'}
          </button>
          <p className="w-full text-sm text-[var(--muted)]">
            Requires Redis. Without <code className="text-[var(--accent)]">GITHUB_TOKEN</code>,
            workers complete scans without live GitHub calls. Scope narrows discovery to one brand
            or a raw GitHub search query — findings still go through the full detection pipeline.
            Max repos requests fewer (or more, up to the admin ceiling) than the default; leave
            blank to use the default.
          </p>
        </div>
        {message ? <p className="mb-4 text-sm text-[var(--accent)]">{message}</p> : null}
        {error ? <p className="mb-4 text-sm text-[var(--danger)]">{error}</p> : null}
        {loading ? <LoadingBlock /> : null}
        {!loading && data && data.data.length === 0 ? (
          <EmptyState title="No scans yet" body="Start a manual scan to create the first job." />
        ) : null}
        {data && data.data.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full text-sm">
              <thead className="bg-[var(--bg-elevated)] text-left text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Repos</th>
                  <th className="px-4 py-3">Skip / Rescan</th>
                  <th className="px-4 py-3">Findings</th>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((s) => (
                  <tr key={s._id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3 capitalize">{s.type}</td>
                    <td className="px-4 py-3">{(s.mode || 'incremental').replaceAll('_', ' ')}</td>
                    <td className="px-4 py-3 capitalize">{s.status}</td>
                    <td className="px-4 py-3">
                      {s.reposProcessed ?? s.reposAnalyzed}/
                      {s.reposDiscovered ?? s.reposFound}
                      {s.reposFailed ? ` (${s.reposFailed} failed)` : ''}
                      {s.maxRepos ? (
                        <span className="text-[var(--muted)]"> (cap {s.maxRepos})</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      skip {s.reposSkipped ?? 0} · rescan {s.reposRescanned ?? 0}
                      {(s.reposResumed ?? 0) > 0 ? ` · resume ${s.reposResumed}` : ''}
                    </td>
                    <td className="px-4 py-3">
                      +{s.findingsNew ?? s.findingsCreated} / ~{s.findingsUnchanged ?? s.findingsUpdated}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {s.startedAt ? new Date(s.startedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/scans/${s._id}`} className="text-[var(--accent)] hover:underline">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
