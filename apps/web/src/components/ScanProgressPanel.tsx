'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import { api, ScanJob } from '@/lib/api';
import {
  ScanProgressEvent,
  openScanProgressStream,
  phaseLabel,
} from '@/lib/scan-progress';

type Transport = 'sse' | 'polling' | 'connecting';

interface Props {
  scanId: string;
  initialJob?: ScanJob | null;
  onJobUpdate?: (job: Partial<ScanJob> & { status: string }) => void;
  onCancel?: () => void;
  onRetry?: () => void;
  busy?: boolean;
}

export function ScanProgressPanel({
  scanId,
  initialJob,
  onJobUpdate,
  onCancel,
  onRetry,
  busy,
}: Props) {
  const [event, setEvent] = useState<ScanProgressEvent | null>(null);
  const [transport, setTransport] = useState<Transport>('connecting');
  const [streamError, setStreamError] = useState('');
  const lastSeq = useRef(0);
  const seen = useRef(new Set<number>());
  const terminalRef = useRef(false);

  const applyEvent = useCallback(
    (next: ScanProgressEvent) => {
      if (seen.current.has(next.seq)) return;
      if (next.seq < lastSeq.current) return;
      seen.current.add(next.seq);
      lastSeq.current = next.seq;
      if (next.terminal) terminalRef.current = true;
      setEvent(next);
      onJobUpdate?.({
        status: next.status,
        message: next.message,
        error: next.type === 'scan.failed' ? next.message : '',
        reposDiscovered: next.counts.reposDiscovered,
        reposProcessed: next.counts.reposProcessed,
        reposFailed: next.counts.reposFailed,
        reposTotal: next.counts.reposTotal,
        reposSkipped: next.counts.reposSkipped,
        reposRescanned: next.counts.reposRescanned,
        reposResumed: next.counts.reposResumed,
        findingsCreated: next.counts.findingsCreated,
        findingsUpdated: next.counts.findingsUpdated,
        findingsNew: next.counts.findingsNew,
        findingsUnchanged: next.counts.findingsUnchanged,
        findingsReopened: next.counts.findingsReopened,
        findingsResolved: next.counts.findingsResolved,
        findingsHighRisk: next.counts.findingsHighRisk,
        cancelRequested:
          next.type === 'scan.cancelled' || next.phase === 'cancelled',
      });
    },
    [onJobUpdate],
  );

  const pollOnce = useCallback(async () => {
    const res = await api<{ event: ScanProgressEvent | null }>(
      `/scans/${scanId}/progress?afterSeq=${lastSeq.current}`,
    );
    if (res.event) applyEvent(res.event);
  }, [applyEvent, scanId]);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    async function start() {
      setStreamError('');
      setTransport('connecting');
      try {
        await pollOnce();
        if (cancelled) return;
        if (terminalRef.current) {
          setTransport('sse');
          return;
        }
        setTransport('sse');
        await openScanProgressStream(
          scanId,
          lastSeq.current,
          (ev) => {
            if (!cancelled) applyEvent(ev);
          },
          abort.signal,
        );
        if (!cancelled && !terminalRef.current) {
          throw new Error('SSE disconnected');
        }
      } catch {
        if (cancelled || abort.signal.aborted || terminalRef.current) return;
        setTransport('polling');
        setStreamError('Live stream unavailable — using polling fallback.');
        pollTimer = setInterval(() => {
          if (terminalRef.current && pollTimer) {
            clearInterval(pollTimer);
            return;
          }
          void pollOnce().catch(() => undefined);
        }, 2000);
      }
    }

    void start();
    return () => {
      cancelled = true;
      abort.abort();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [applyEvent, pollOnce, scanId]);

  const percent = event?.percent ?? initialJob?.progressPercent ?? 0;
  const phase =
    event?.phase || initialJob?.progressPhase || initialJob?.status || 'queued';
  const status = event?.status || initialJob?.status || 'queued';
  const message =
    event?.message || initialJob?.message || 'Waiting for progress…';
  const counts = event?.counts || {
    reposDiscovered: initialJob?.reposDiscovered ?? initialJob?.reposFound ?? 0,
    reposProcessed: initialJob?.reposProcessed ?? initialJob?.reposAnalyzed ?? 0,
    reposFailed: initialJob?.reposFailed ?? 0,
    reposTotal: initialJob?.reposTotal ?? 0,
    findingsCreated: initialJob?.findingsCreated ?? 0,
    findingsUpdated: initialJob?.findingsUpdated ?? 0,
    queriesTotal: 0,
    queriesCompleted: 0,
    reposSkipped: initialJob?.reposSkipped ?? 0,
    reposRescanned: initialJob?.reposRescanned ?? 0,
    reposResumed: initialJob?.reposResumed ?? 0,
    reposPendingAnalysis: initialJob?.reposPendingAnalysis ?? 0,
    findingsNew: initialJob?.findingsNew ?? 0,
    findingsUnchanged: initialJob?.findingsUnchanged ?? 0,
    findingsReopened: initialJob?.findingsReopened ?? 0,
    findingsResolved: initialJob?.findingsResolved ?? 0,
    findingsHighRisk: initialJob?.findingsHighRisk ?? 0,
  };

  const terminal =
    event?.terminal ||
    ['completed', 'partially_completed', 'failed', 'cancelled'].includes(
      status,
    );
  const canCancel =
    !terminal && (status === 'queued' || status === 'running') && !!onCancel;
  const canRetry =
    terminal &&
    (status === 'failed' ||
      status === 'partially_completed' ||
      status === 'cancelled') &&
    !!onRetry;

  const statusTone =
    status === 'failed'
      ? 'var(--danger)'
      : status === 'cancelled'
        ? 'var(--muted)'
        : status === 'completed' || status === 'partially_completed'
          ? 'var(--accent)'
          : 'var(--text)';

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
            Phase
          </p>
          <p className="text-lg font-medium">{phaseLabel(String(phase))}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
            Status
          </p>
          <p className="capitalize font-medium" style={{ color: statusTone }}>
            {status.replaceAll('_', ' ')}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {transport === 'sse'
              ? 'Live (SSE)'
              : transport === 'polling'
                ? 'Polling fallback'
                : 'Connecting…'}
          </p>
        </div>
      </div>

      <div>
        <div className="mb-1 flex justify-between text-xs text-[var(--muted)]">
          <span>Progress</span>
          <span>{Math.round(percent)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--border)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      </div>

      <p className="text-sm">{message}</p>

      <HighRiskSummary
        reposProcessed={counts.reposProcessed}
        findingsHighRisk={counts.findingsHighRisk ?? 0}
        internalAudit={!!initialJob?.internalAudit}
      />

      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Discovered" value={counts.reposDiscovered} />
        <Stat label="Processed" value={counts.reposProcessed} />
        <Stat label="Skipped" value={counts.reposSkipped ?? 0} />
        <Stat label="Rescanned" value={counts.reposRescanned ?? 0} />
        <Stat label="Resumed" value={counts.reposResumed ?? 0} />
        <Stat label="Failed" value={counts.reposFailed} />
        {initialJob?.discoveryOnly || (counts.reposPendingAnalysis ?? 0) > 0 ? (
          <Stat
            label="Pending analysis"
            value={counts.reposPendingAnalysis ?? 0}
          />
        ) : null}
        <Stat label="Findings new" value={counts.findingsNew ?? counts.findingsCreated} />
        <Stat
          label="Unchanged / reopened"
          value={(counts.findingsUnchanged ?? 0) + (counts.findingsReopened ?? 0)}
        />
        <Stat
          label={initialJob?.internalAudit ? 'Leaking credentials' : 'Flagged high-risk'}
          value={counts.findingsHighRisk ?? 0}
          danger={(counts.findingsHighRisk ?? 0) > 0}
        />
      </div>

      {streamError && transport === 'polling' ? (
        <p className="text-xs text-[var(--muted)]">{streamError}</p>
      ) : null}

      {status === 'failed' && (event?.message || initialJob?.error) ? (
        <Alert tone="danger">{event?.message || initialJob?.error}</Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canCancel ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            Cancel scan
          </Button>
        ) : null}
        {canRetry ? (
          <Button type="button" size="sm" disabled={busy} onClick={onRetry}>
            Retry scan
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div
      className="rounded border px-3 py-2"
      style={
        danger
          ? {
              borderColor: 'var(--danger-border-soft)',
              background: 'var(--danger-soft)',
            }
          : undefined
      }
    >
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p
        className="text-base font-medium"
        style={danger ? { color: 'var(--danger)' } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * The headline answer to "out of the repos we looked at, how many actually
 * matter" - separate from the generic stat grid below since this is the
 * number a reviewer cares about most and shouldn't have to hunt for it among
 * eight other counters.
 */
function HighRiskSummary({
  reposProcessed,
  findingsHighRisk,
  internalAudit,
}: {
  reposProcessed: number;
  findingsHighRisk: number;
  internalAudit: boolean;
}) {
  if (reposProcessed === 0) return null;
  const flaggedLabel = internalAudit
    ? findingsHighRisk === 1
      ? 'repo is leaking a credential'
      : 'repos are leaking credentials'
    : findingsHighRisk === 1
      ? 'repo looks like a real threat'
      : 'repos look like a real threat';
  return (
    <div
      className="rounded-lg border px-3 py-2 text-sm"
      style={
        findingsHighRisk > 0
          ? { borderColor: 'var(--danger-border-soft)', background: 'var(--danger-soft)' }
          : { borderColor: 'var(--border)' }
      }
    >
      Scanned{' '}
      <span className="font-medium">{reposProcessed}</span>{' '}
      {reposProcessed === 1 ? 'repository' : 'repositories'} so far —{' '}
      <span
        className="font-semibold"
        style={findingsHighRisk > 0 ? { color: 'var(--danger)' } : undefined}
      >
        {findingsHighRisk}
      </span>{' '}
      {flaggedLabel}.
    </div>
  );
}
