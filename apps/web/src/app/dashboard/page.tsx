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
import {
  Card,
  CardSkeleton,
  DemoBanner,
  EmptyState,
  ErrorState,
  SeverityBadge,
  StatCard,
} from '@/components/ui';
import { api, DashboardSummary, Finding } from '@/lib/api';
import { formatTime } from '@/lib/date';

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
        {loading ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <CardSkeleton count={4} />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <CardSkeleton count={2} />
            </div>
          </div>
        ) : null}
        {error ? <ErrorState message={error} /> : null}
        {data ? (
          <div className="space-y-8">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Total findings" value={data.totalFindings} />
              <StatCard
                label="Critical"
                value={data.criticalFindings}
                hint="Score 85–100"
                valueColor="var(--critical)"
              />
              <StatCard
                label="High risk"
                value={data.highFindings}
                hint="Score 65–84"
                valueColor="var(--high)"
              />
              <StatCard label="Repos scanned" value={data.reposScanned} />
            </div>

            {data.githubRateLimit ? (
              <Card className="space-y-3 p-4">
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
                            ? `Resets ${formatTime(snap.resetAt)}`
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
                        ? `Paused until ${formatTime(data.githubRateLimit.pause.pausedUntil)}`
                        : data.githubRateLimit.secondaryRetryAfterUntil
                          ? `Secondary limit until ${formatTime(data.githubRateLimit.secondaryRetryAfterUntil)}`
                          : 'No active pause'}
                    </p>
                  </div>
                </div>
                {data.githubRateLimit.warnings.length > 0 ? (
                  <ul className="space-y-1">
                    {data.githubRateLimit.warnings.map((w) => (
                      <li
                        key={w}
                        className="rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]"
                      >
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-[var(--muted)]">No quota warnings.</p>
                )}
              </Card>
            ) : null}

            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="p-4">
                <h2 className="text-sm font-medium mb-4">Findings by severity</h2>
                {data.findingsBySeverity.length === 0 ? (
                  <EmptyState title="No findings yet" body="Run a manual scan or seed demo data." />
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.findingsBySeverity}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis
                          dataKey="severity"
                          stroke="var(--border)"
                          tick={{ fill: 'var(--muted)' }}
                        />
                        <YAxis
                          stroke="var(--border)"
                          tick={{ fill: 'var(--muted)' }}
                          allowDecimals={false}
                        />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border)',
                            color: 'var(--text)',
                          }}
                          labelStyle={{ color: 'var(--text)' }}
                        />
                        <Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>

              <Card className="p-4">
                <h2 className="text-sm font-medium mb-4">Findings over time</h2>
                {data.findingsOverTime.length === 0 ? (
                  <EmptyState title="No timeline yet" body="Findings will appear here after scans." />
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.findingsOverTime}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="date" stroke="var(--border)" hide />
                        <YAxis
                          stroke="var(--border)"
                          tick={{ fill: 'var(--muted)' }}
                          allowDecimals={false}
                        />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border)',
                            color: 'var(--text)',
                          }}
                          labelStyle={{ color: 'var(--text)' }}
                        />
                        <Line type="monotone" dataKey="count" stroke="var(--warning)" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>
            </div>

            <Card className="p-4">
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
                <ul className="flex flex-col gap-2">
                  {data.recentCritical.map((f: Finding) => (
                    <li
                      key={f._id}
                      className="flex items-start justify-between gap-4 rounded-lg border-l-4 border-y border-r border-[var(--border)] bg-[var(--bg-subtle)]/50 px-4 py-3 transition-colors duration-150 hover:border-[var(--accent-border)]"
                      style={{
                        borderLeftColor:
                          f.severity === 'critical' ? 'var(--critical)' : 'var(--high)',
                      }}
                    >
                      <div>
                        <Link
                          href={`/findings/${f._id}`}
                          className="font-medium hover:text-[var(--accent)]"
                        >
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
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-medium mb-3">Findings by category</h2>
              <div className="flex flex-wrap gap-2">
                {data.findingsByCategory.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No categories yet.</p>
                ) : (
                  data.findingsByCategory.map((c) => (
                    <span
                      key={c.category}
                      className="rounded-lg border border-[var(--border)] px-3 py-1 text-sm"
                    >
                      {c.category.replace(/_/g, ' ')} · {c.count}
                    </span>
                  ))
                )}
              </div>
            </Card>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
