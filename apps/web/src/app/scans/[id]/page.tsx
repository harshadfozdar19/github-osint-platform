'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { ScanProgressPanel } from '@/components/ScanProgressPanel';
import { Alert, Button, Card, ErrorState, LoadingBlock } from '@/components/ui';
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

  // Runs real content analysis (clone/fetch, detection, findings) on every
  // repo any discoveryOnly scan has found and saved so far - not just this
  // one's - since Repository.pendingAnalysis accumulates workspace-wide
  // across however many "Discover only" runs have happened.
  async function analyzeDiscovered() {
    setBusy(true);
    setError('');
    try {
      const next = await api<ScanJob>('/scans/manual', {
        method: 'POST',
        body: JSON.stringify({ mode: 'analyze_pending' }),
      });
      setMessage(`Analysis accepted (${next.status}). Opening live progress…`);
      router.push(`/scans/${next._id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start analysis');
    } finally {
      setBusy(false);
    }
  }

  return (
    <RequireAuth>
      <AppShell title="Scan detail">
        <p className="mb-4">
          <Link href="/scans" className="text-sm text-[var(--accent)] hover:underline">
            ← Back to scans
          </Link>
        </p>
        {loading ? <LoadingBlock /> : null}
        {message ? <Alert tone="success" className="mb-3">{message}</Alert> : null}
        {error ? <ErrorState message={error} /> : null}
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
            <Card className="space-y-3 p-5 text-sm">
              <p>
                <span className="text-[var(--muted)]">Type:</span> {job.type}
              </p>
              <p>
                <span className="text-[var(--muted)]">Mode:</span>{' '}
                {(job.mode || 'incremental').replaceAll('_', ' ')}
                {job.forceFullScan ? ' (forced full)' : ''}
                {job.discoveryOnly ? (
                  <span className="ml-2 text-xs text-[var(--accent)]">
                    (discover only — no content analysis run)
                  </span>
                ) : null}
              </p>
              {job.discoveryOnly ? (
                <p>
                  <span className="text-[var(--muted)]">Saved for later analysis:</span>{' '}
                  {job.reposPendingAnalysis ?? 0}
                  <Button
                    type="button"
                    size="sm"
                    onClick={analyzeDiscovered}
                    disabled={busy}
                    className="ml-3"
                    title="Runs content analysis on every repo discovered-but-not-analyzed so far across the whole workspace, not just this scan."
                  >
                    Analyze discovered repositories
                  </Button>
                </p>
              ) : null}
              <p>
                <span className="text-[var(--muted)]">Scan ID:</span>{' '}
                <code className="text-xs">{job._id}</code>
              </p>
              {job.maxRepos && job.maxRepos < Number.MAX_SAFE_INTEGER ? (
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
              <p>
                <span className="text-[var(--muted)]">
                  {job.internalAudit ? 'Leaking credentials:' : 'Flagged high-risk:'}
                </span>{' '}
                <span
                  style={
                    (job.findingsHighRisk ?? 0) > 0
                      ? { color: 'var(--danger)', fontWeight: 600 }
                      : undefined
                  }
                >
                  {job.findingsHighRisk ?? 0}
                </span>{' '}
                of {job.reposProcessed ?? job.reposAnalyzed ?? 0} repos scanned
              </p>
              <div>
                <p className="text-[var(--muted)] mb-2">
                  Queries used
                  {job.continueDiscovery ? (
                    <span className="ml-2 text-xs text-[var(--accent)]">
                      (continue from last scan was on)
                    </span>
                  ) : null}
                </p>
                {(job.queriesUsed || []).length === 0 ? (
                  <p className="text-[var(--muted)]">—</p>
                ) : (
                  <ul className="list-disc pl-5 space-y-1 font-[family-name:var(--font-mono)] text-xs">
                    {(job.queriesUsed || []).map((q, i) => {
                      const startPage = job.checkpoint?.searchStartPages?.[String(i)];
                      return (
                        <li key={q}>
                          {q}
                          {startPage && startPage > 1 ? (
                            <span
                              className="ml-2 font-[family-name:var(--font-sans)]"
                              style={{ color: 'var(--accent)' }}
                              title="This query picked up a prior scan's saved position instead of re-fetching the same top results."
                            >
                              — resumed from page {startPage}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </Card>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
