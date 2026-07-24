'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { EmptyState, LoadingBlock, SeverityBadge } from '@/components/ui';
import { api, AlertItem, Finding, Paginated } from '@/lib/api';

interface AlertsResponse extends Paginated<AlertItem> {
  unreadCount: number;
}

export default function AlertsPage() {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await api<AlertsResponse>('/alerts?limit=50');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function markRead(id: string) {
    await api(`/alerts/${id}/read`, { method: 'PATCH' });
    await load();
  }

  return (
    <RequireAuth>
      <AppShell
        title="Alerts"
        subtitle="In-app alerts for new Critical and High findings. Email/Slack can plug into the same service later."
      >
        {loading ? <LoadingBlock /> : null}
        {error ? <p className="text-[var(--danger)]">{error}</p> : null}
        {data ? (
          <p className="mb-4 text-sm text-[var(--muted)]">Unread: {data.unreadCount}</p>
        ) : null}
        {!loading && data && data.data.length === 0 ? (
          <EmptyState
            title="No alerts"
            body="Critical and High findings will create alerts automatically."
          />
        ) : null}
        <ul className="space-y-3">
          {data?.data.map((a) => {
            const findingId =
              typeof a.findingId === 'string'
                ? a.findingId
                : (a.findingId as Finding | undefined)?._id;
            return (
              <li
                key={a._id}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  {!a.read ? (
                    <span className="text-xs text-[var(--accent)]">NEW</span>
                  ) : null}
                  <h3 className="font-medium">{a.title}</h3>
                </div>
                <p className="mt-2 text-sm text-[var(--muted)]">{a.message}</p>
                <div className="mt-3 flex gap-3 text-sm">
                  {findingId ? (
                    <Link href={`/findings/${findingId}`} className="text-[var(--accent)] hover:underline">
                      Open finding
                    </Link>
                  ) : null}
                  {!a.read ? (
                    <button
                      type="button"
                      onClick={() => markRead(a._id)}
                      className="text-[var(--muted)] hover:text-[var(--text)]"
                    >
                      Mark read
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </AppShell>
    </RequireAuth>
  );
}
