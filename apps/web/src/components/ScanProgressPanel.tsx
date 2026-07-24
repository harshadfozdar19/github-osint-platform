'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
    findingsNew: initialJob?.findingsNew ?? 0,
    findingsUnchanged: initialJob?.findingsUnchanged ?? 0,
    findingsReopened: initialJob?.findingsReopened ?? 0,
    findingsResolved: initialJob?.findingsResolved ?? 0,
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
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5 space-y-4">
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
        <div className="h-2 overflow-hidden rounded bg-[var(--border)]">
          <div
            className="h-full rounded bg-[var(--accent)] transition-[width] duration-500"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      </div>

      <p className="text-sm">{message}</p>

      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Discovered" value={counts.reposDiscovered} />
        <Stat label="Processed" value={counts.reposProcessed} />
        <Stat label="Skipped" value={counts.reposSkipped ?? 0} />
        <Stat label="Rescanned" value={counts.reposRescanned ?? 0} />
        <Stat label="Resumed" value={counts.reposResumed ?? 0} />
        <Stat label="Failed" value={counts.reposFailed} />
        <Stat label="Findings new" value={counts.findingsNew ?? counts.findingsCreated} />
        <Stat
          label="Unchanged / reopened"
          value={(counts.findingsUnchanged ?? 0) + (counts.findingsReopened ?? 0)}
        />
      </div>

      {streamError && transport === 'polling' ? (
        <p className="text-xs text-[var(--muted)]">{streamError}</p>
      ) : null}

      {status === 'failed' && (event?.message || initialJob?.error) ? (
        <p className="rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
          {event?.message || initialJob?.error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canCancel ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--bg)] disabled:opacity-60"
          >
            Cancel scan
          </button>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            disabled={busy}
            onClick={onRetry}
            className="rounded-md bg-[var(--accent-dim)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            Retry scan
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-[var(--border)] px-3 py-2">
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="text-base font-medium">{value}</p>
    </div>
  );
}
