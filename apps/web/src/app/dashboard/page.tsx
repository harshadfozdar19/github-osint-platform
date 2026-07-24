'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { DemoBanner, EmptyState, LoadingBlock, SeverityBadge, StatCard } from '@/components/ui';
import { api, DashboardSummary, Finding } from '@/lib/api';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<DashboardSummary>('/dashboard/summary')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const hasDemo = data?.recentCritical?.some((f) => f.isDemo);

  return (
    <RequireAuth>
      <AppShell
        title="Threat overview"
        subtitle="Live summary of OSINT findings across monitored brands."
      >
        {hasDemo ? <DemoBanner /> : null}
        {loading ? <LoadingBlock label="Loading dashboard…" /> : null}
        {error ? <p className="text-[var(--danger)]">{error}</p> : null}
        {data ? (
          <div className="space-y-8">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Total findings" value={data.totalFindings} />
              <StatCard label="Critical" value={data.criticalFindings} hint="Score 85–100" />
              <StatCard label="High risk" value={data.highFindings} hint="Score 65–84" />
              <StatCard label="Repos scanned" value={data.reposScanned} />
            </div>

            {data.githubRateLimit ? (
              <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium">GitHub API quota</h2>
                    <p className="text-xs text-[var(--muted)] mt-1">
                      Shared across workers · workspace budgets prevent noisy-neighbor scans
                    </p>
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {data.githubRateLimit.configured ? 'Token configured' : 'No GITHUB_TOKEN'}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                  {(['core', 'search'] as const).map((key) => {
                    const snap = data.githubRateLimit?.primary?.[key];
                    return (
                      <div
                        key={key}
                        className="rounded border border-[var(--border)] px-3 py-2"
                      >
                        <p className="text-xs uppercase text-[var(--muted)]">{key}</p>
                        <p className="font-medium mt-1">
                          {snap
                            ? `${snap.remaining} / ${snap.limit}`
                            : '—'}
                        </p>
                        <p className="text-xs text-[var(--muted)] mt-1">
                          {snap
                            ? `Resets ${new Date(snap.resetAt).toLocaleTimeString()}`
                            : 'No samples yet'}
                        </p>
                      </div>
                    );
                  })}
                  <div className="rounded border border-[var(--border)] px-3 py-2">
                    <p className="text-xs uppercase text-[var(--muted)]">Workspace budget</p>
                    <p className="font-medium mt-1">
                      {data.githubRateLimit.workspace
                        ? `${data.githubRateLimit.workspace.remaining} left`
                        : '—'}
                    </p>
                    <p className="text-xs text-[var(--muted)] mt-1">
                      {data.githubRateLimit.workspace
                        ? `${data.githubRateLimit.workspace.used}/${data.githubRateLimit.workspace.limit} today · in-flight ${data.githubRateLimit.workspace.inFlight}/${data.githubRateLimit.workspace.maxConcurrency}`
                        : 'No budget data'}
                    </p>
                  </div>
                  <div className="rounded border border-[var(--border)] px-3 py-2">
                    <p className="text-xs uppercase text-[var(--muted)]">Paused scans</p>
                    <p className="font-medium mt-1">
                      {data.githubRateLimit.pausedScanCount}
                    </p>
                    <p className="text-xs text-[var(--muted)] mt-1">
                      {data.githubRateLimit.pause.paused
                        ? `Paused until ${new Date(data.githubRateLimit.pause.pausedUntil || 0).toLocaleTimeString()}`
                        : data.githubRateLimit.secondaryRetryAfterUntil
                          ? `Secondary limit until ${new Date(data.githubRateLimit.secondaryRetryAfterUntil).toLocaleTimeString()}`
                          : 'No active pause'}
                    </p>
                  </div>
                </div>
                {data.githubRateLimit.warnings.length > 0 ? (
                  <ul className="space-y-1">
                    {data.githubRateLimit.warnings.map((w) => (
                      <li
                        key={w}
                        className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
                      >
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-[var(--muted)]">No quota warnings.</p>
                )}
              </section>
            ) : null}

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4">
                <h2 className="text-sm font-medium mb-4">Findings by severity</h2>
                {data.findingsBySeverity.length === 0 ? (
                  <EmptyState title="No findings yet" body="Run a manual scan or seed demo data." />
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.findingsBySeverity}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#372a54" />
                        <XAxis dataKey="severity" stroke="#a99bc7" />
                        <YAxis stroke="#a99bc7" allowDecimals={false} />
                        <Tooltip
                          contentStyle={{
                            background: '#1a1330',
                            border: '1px solid #372a54',
                          }}
                        />
                        <Bar dataKey="count" fill="#c084fc" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>

              <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4">
                <h2 className="text-sm font-medium mb-4">Findings over time</h2>
                {data.findingsOverTime.length === 0 ? (
                  <EmptyState title="No timeline yet" body="Findings will appear here after scans." />
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.findingsOverTime}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#372a54" />
                        <XAxis dataKey="date" stroke="#a99bc7" hide />
                        <YAxis stroke="#a99bc7" allowDecimals={false} />
                        <Tooltip
                          contentStyle={{
                            background: '#1a1330',
                            border: '1px solid #372a54',
                          }}
                        />
                        <Line type="monotone" dataKey="count" stroke="#facc15" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>
            </div>

            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium">Recent critical / high findings</h2>
                <Link href="/findings" className="text-sm text-[var(--accent)] hover:underline">
                  View all
                </Link>
              </div>
              {data.recentCritical.length === 0 ? (
                <EmptyState
                  title="No critical findings"
                  body="When Critical or High findings appear, they will show here and generate alerts."
                />
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {data.recentCritical.map((f: Finding) => (
                    <li key={f._id} className="py-3 flex items-start justify-between gap-4">
                      <div>
                        <Link href={`/findings/${f._id}`} className="hover:text-[var(--accent)]">
                          {f.summary}
                        </Link>
                        <p className="text-xs text-[var(--muted)] mt-1">
                          Score {f.riskScore}
                          {f.brandName ? ` · ${f.brandName}` : ''}
                          {f.isDemo ? ' · DEMO' : ''}
                        </p>
                      </div>
                      <SeverityBadge severity={f.severity} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4">
              <h2 className="text-sm font-medium mb-3">Findings by category</h2>
              <div className="flex flex-wrap gap-2">
                {data.findingsByCategory.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No categories yet.</p>
                ) : (
                  data.findingsByCategory.map((c) => (
                    <span
                      key={c.category}
                      className="rounded-md border border-[var(--border)] px-3 py-1 text-sm"
                    >
                      {c.category.replace(/_/g, ' ')} · {c.count}
                    </span>
                  ))
                )}
              </div>
            </section>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
