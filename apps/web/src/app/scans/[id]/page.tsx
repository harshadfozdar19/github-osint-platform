'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { ScanProgressPanel } from '@/components/ScanProgressPanel';
import { LoadingBlock } from '@/components/ui';
import { api, ScanJob } from '@/lib/api';

export default function ScanDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = useState<ScanJob | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!params.id) return;
    setLoading(true);
    api<ScanJob>(`/scans/${params.id}`)
      .then(setJob)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [params.id]);

  // Stable identity: ScanProgressPanel's SSE effect depends on this via
  // applyEvent, so a fresh function on every render would tear down and
  // reopen the SSE connection on every single progress event.
  const handleJobUpdate = useCallback(
    (partial: Partial<ScanJob> & { status: string }) =>
      setJob((prev) => (prev ? { ...prev, ...partial } : prev)),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function cancelScan() {
    if (!params.id) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<ScanJob>(`/scans/${params.id}/cancel`, {
        method: 'POST',
      });
      setJob(updated);
      setMessage('Cancel requested');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  async function retryScan() {
    if (!params.id) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<ScanJob>(`/scans/${params.id}/retry`, {
        method: 'POST',
      });
      setMessage(`Retry accepted (${next.status}). Opening new scan…`);
      router.push(`/scans/${next._id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <RequireAuth>
      <AppShell
        title="Scan detail"
        subtitle="Live progress via SSE (polling fallback if the stream drops)."
      >
        <p className="mb-4">
          <Link href="/scans" className="text-sm text-[var(--accent)] hover:underline">
            ← Back to scans
          </Link>
        </p>
        {loading ? <LoadingBlock /> : null}
        {message ? <p className="mb-3 text-sm text-[var(--accent)]">{message}</p> : null}
        {error ? <p className="mb-3 text-[var(--danger)]">{error}</p> : null}
        {job && params.id ? (
          <div className="space-y-4">
            <ScanProgressPanel
              scanId={params.id}
              initialJob={job}
              busy={busy}
              onCancel={cancelScan}
              onRetry={retryScan}
              onJobUpdate={handleJobUpdate}
            />
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5 space-y-3 text-sm">
              <p>
                <span className="text-[var(--muted)]">Type:</span> {job.type}
              </p>
              <p>
                <span className="text-[var(--muted)]">Mode:</span>{' '}
                {(job.mode || 'incremental').replaceAll('_', ' ')}
                {job.forceFullScan ? ' (forced full)' : ''}
              </p>
              <p>
                <span className="text-[var(--muted)]">Scan ID:</span>{' '}
                <code className="text-xs">{job._id}</code>
              </p>
              {job.maxRepos ? (
                <p>
                  <span className="text-[var(--muted)]">Max repos:</span> {job.maxRepos}
                </p>
              ) : null}
              <p>
                <span className="text-[var(--muted)]">Incremental:</span>{' '}
                skipped {job.reposSkipped ?? 0}, rescanned {job.reposRescanned ?? 0},
                resumed {job.reposResumed ?? 0}
              </p>
              <p>
                <span className="text-[var(--muted)]">Findings lifecycle:</span>{' '}
                new {job.findingsNew ?? 0}, unchanged {job.findingsUnchanged ?? 0},
                reopened {job.findingsReopened ?? 0}, resolved {job.findingsResolved ?? 0}
              </p>
              <div>
                <p className="text-[var(--muted)] mb-2">Queries used</p>
                {(job.queriesUsed || []).length === 0 ? (
                  <p className="text-[var(--muted)]">—</p>
                ) : (
                  <ul className="list-disc pl-5 space-y-1 font-[family-name:var(--font-mono)] text-xs">
                    {(job.queriesUsed || []).map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
