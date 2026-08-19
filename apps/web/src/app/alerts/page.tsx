'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { Badge, Card, CardSkeleton, EmptyState, ErrorState, SeverityBadge } from '@/components/ui';
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
        {loading ? (
          <div className="space-y-3">
            <CardSkeleton count={3} />
          </div>
        ) : null}
        {error ? <ErrorState message={error} /> : null}
        {data ? (
          <p className="mb-4 text-sm text-[var(--muted)]">
            Unread: <span className="font-medium text-[var(--text)]">{data.unreadCount}</span>
          </p>
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
              <Card key={a._id} as="li" className={a.read ? 'p-4' : 'border-[var(--accent-border)] p-4'}>
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  {!a.read ? <Badge tone="accent" dot>NEW</Badge> : null}
                  <h3 className="font-semibold">{a.title}</h3>
                </div>
                <p className="mt-2 text-sm text-[var(--muted)]">{a.message}</p>
                <div className="mt-3 flex gap-4 text-sm">
                  {findingId ? (
                    <Link
                      href={`/findings/${findingId}`}
                      className="font-medium text-[var(--accent)] hover:underline"
                    >
                      Open finding
                    </Link>
                  ) : null}
                  {!a.read ? (
                    <button
                      type="button"
                      onClick={() => markRead(a._id)}
                      className="text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]"
                    >
                      Mark read
                    </button>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </ul>
      </AppShell>
    </RequireAuth>
  );
}
