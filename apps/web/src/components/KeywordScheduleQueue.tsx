'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Badge, Button, Card } from '@/components/ui';
import { api, ApiError, Brand, KeywordRotationSlot, KeywordRotationStatus } from '@/lib/api';

/** Per-keyword lifetime discovery total (GET /scans/active-by-keyword) - reposDiscovered there is summed across EVERY scan ever run for that keyword, not just the current one, so it's already a running lifetime count. */
type ActiveByKeywordEntry = { reposDiscovered: number };
type ActiveByKeyword = Record<string, ActiveByKeywordEntry>;

/** Always HH:MM:SS, unlike KeywordScanner's variable-width formatElapsed - this is a fixed schedule, not an open-ended "how long has this been running" counter. */
function formatHms(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Generic on/off toggle switch - used for pause/resume of one specific keyword. */
function Toggle({
  on,
  busy,
  onOn,
  onOff,
  onTitle,
  offTitle,
}: {
  on: boolean;
  busy: boolean;
  onOn: () => void;
  onOff: () => void;
  onTitle: string;
  offTitle: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => (on ? onOff() : onOn())}
      className="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-40"
      style={{ background: on ? 'var(--accent)' : 'var(--border)' }}
      title={on ? onTitle : offTitle}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: on ? '18px' : '2px' }}
      />
    </button>
  );
}

function slotKey(brandId: string, keyword: string): string {
  return `${brandId} ${keyword}`;
}

/**
 * Drops `paused` - used where the intent is "run this slot regardless of
 * whatever it was doing before" (Start all keywords, and appending a queue
 * entry that was never paused to begin with). Do NOT use this for anything
 * that must preserve an existing slot's pause state - see
 * toSlotInputPreservePaused, and its doc comment for why the distinction
 * matters here specifically.
 */
function toSlotInput(slot: KeywordRotationSlot): KeywordRotationSlot {
  return {
    brandId: slot.brandId,
    keyword: slot.keyword,
    durationMs: slot.durationMs,
    searchScope: slot.searchScope,
    continueDiscovery: slot.continueDiscovery,
  };
}

/**
 * Same as toSlotInput but keeps `paused` as-is. Start/add REPLACE-or-append
 * the whole slot list server-side (KeywordRotationService.start/addSlots),
 * so a slot left out of the payload isn't just skipped - it's deleted from
 * the queue entirely. "Start the scan" must therefore always resend every
 * already-configured slot (paused or not), and that only works without
 * silently un-pausing everything if the paused ones say so explicitly - see
 * KeywordRotationSlotDto.paused.
 */
function toSlotInputPreservePaused(slot: KeywordRotationSlot): KeywordRotationSlot {
  return { ...toSlotInput(slot), paused: slot.paused === true };
}

const SEARCH_SCOPE_OPTIONS: { value: 'both' | 'repositories' | 'code'; label: string; title: string }[] = [
  { value: 'both', label: 'Both', title: 'Search both repository names/descriptions AND code content for this keyword' },
  { value: 'repositories', label: 'Repo', title: "Repository search only - skips code search entirely, including GitHub's much tighter 10/min code-search limit" },
  { value: 'code', label: 'Code', title: 'Code search only - skips repository search entirely' },
];

/** Compact 3-way segmented control choosing which GitHub search kind(s) one keyword's turn runs, instead of always running both and depending on the system to pace between them. */
function SearchScopeToggle({
  value,
  busy,
  onChange,
}: {
  value: 'both' | 'repositories' | 'code';
  busy: boolean;
  onChange: (next: 'both' | 'repositories' | 'code') => void;
}) {
  return (
    <div
      className="inline-flex shrink-0 rounded-md border border-[var(--border)] p-0.5"
      title="Which GitHub search kind(s) this keyword's turn runs"
    >
      {SEARCH_SCOPE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={busy}
          onClick={() => opt.value !== value && onChange(opt.value)}
          title={opt.title}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 disabled:opacity-40"
          style={{
            background: value === opt.value ? 'var(--accent)' : 'transparent',
            color: value === opt.value ? 'white' : 'var(--muted)',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Compact 2-way segmented control choosing whether one keyword's turn resumes its queries from where discovery last left off, or restarts every query at page 1 every turn. */
function DiscoveryPaginationToggle({
  value,
  busy,
  onChange,
}: {
  /** True = resume from last (default), false = start from beginning. */
  value: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className="inline-flex shrink-0 rounded-md border border-[var(--border)] p-0.5"
      title="Whether this keyword's turn resumes from where its own discovery last left off, or restarts every query at page 1 every turn"
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => value && onChange(false)}
        title="Every query starts fresh at page 1 on every turn - re-fetches the same top (most-recently-updated) results each time."
        className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 disabled:opacity-40"
        style={{
          background: !value ? 'var(--accent)' : 'transparent',
          color: !value ? 'white' : 'var(--muted)',
        }}
      >
        Start from beginning
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => !value && onChange(true)}
        title="Resume this keyword's queries from where this workspace's own discovery of them last left off, instead of re-fetching the same top results every turn."
        className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 disabled:opacity-40"
        style={{
          background: value ? 'var(--accent)' : 'transparent',
          color: value ? 'white' : 'var(--muted)',
        }}
      >
        Resume from last
      </button>
    </div>
  );
}

/**
 * Sequential scheduler: build an ordered, workspace-wide queue of
 * (company, keyword, duration) triples via KeywordScanner's "Schedule"
 * column ("Next →" adds here), reorder it, then start it - runs exactly ONE
 * keyword at a time, each getting the workspace's whole GitHub token quota
 * for its own duration instead of splitting it across every keyword running
 * concurrently, then hands off to the next queued keyword. The queue can mix
 * keywords from several different companies and persists across switching
 * which company you're browsing below - it is not reset by that.
 *
 * Configured keywords (status.slots) are ALWAYS shown once they exist,
 * whether the scheduler is currently running, stopped, or every one of them
 * got individually paused - stopping never deletes the queue server-side
 * (see KeywordRotationService.stop/pauseSlot), so the UI must not hide it
 * either just because `enabled` happens to be false right now.
 */
export function KeywordScheduleQueue({
  brands,
  queue,
  onQueueChange,
  onRefreshScans,
}: {
  brands: Brand[];
  queue: KeywordRotationSlot[];
  onQueueChange: (next: KeywordRotationSlot[]) => void;
  /** Refreshes the page's "Currently running" scans table - surfaced here, next to Stop scheduler, so it's reachable from the same top-of-page spot regardless of which scan-start option is chosen further down the page. */
  onRefreshScans?: () => void;
}) {
  const [status, setStatus] = useState<KeywordRotationStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  // Which of the two start actions `busy` covers right now - so the OTHER
  // start button doesn't also flash a loading state it isn't responsible
  // for. Not used for anything else that sets `busy` (stop, addToRunning).
  const [busyAction, setBusyAction] = useState<'scan' | 'all' | null>(null);
  // Toggles the "which keywords is Start the scan about to run" preview -
  // collapsed by default so a long queue doesn't dominate the page.
  const [scanPreviewOpen, setScanPreviewOpen] = useState(false);
  // Which single slot (by "brandId keyword") a pause/resume request is
  // in-flight for - independent of `busy`, which is only for the
  // whole-queue start/stop/add actions.
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Separate from `error` (result of a deliberate action - start/stop/
  // pause/resume/remove) so a background loadStatus poll failure doesn't
  // clobber an action-result message, and so a failed poll is visible at
  // all instead of just making the whole scheduler section silently vanish.
  const [loadError, setLoadError] = useState('');
  const [dateMode, setDateMode] = useState<'any' | 'dated'>('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // brandId -> keyword -> lifetime repos discovered - see loadDiscoveredCounts.
  const [discoveredCounts, setDiscoveredCounts] = useState<
    Record<string, Record<string, number>>
  >({});

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const brandNameById = new Map(brands.map((b) => [b._id, b.name]));

  function loadStatus() {
    api<KeywordRotationStatus | null>('/scans/keyword-rotation')
      .then((res) => {
        setStatus(res);
        setLoadError('');
      })
      .catch(() =>
        setLoadError('Failed to load scheduler status - retrying automatically.'),
      );
  }

  /**
   * Fetches discovered-repo totals for every distinct company referenced
   * across the queue and the configured rotation, in parallel - one request
   * per company, not per keyword. Merges into existing state per-keyword
   * (never wholesale-replaces a brand's map) and skips brands whose request
   * failed - a transient network hiccup or a response that happens not to
   * include every keyword must never zero out a count we already know is
   * real.
   */
  function loadDiscoveredCounts(brandIds: string[]) {
    const distinct = [...new Set(brandIds)];
    if (distinct.length === 0) return;
    Promise.all(
      distinct.map((brandId) =>
        api<ActiveByKeyword>(`/scans/active-by-keyword?brandId=${brandId}`)
          .then((res) => [brandId, res, true] as const)
          .catch(() => [brandId, {} as ActiveByKeyword, false] as const),
      ),
    ).then((results) => {
      setDiscoveredCounts((prev) => {
        const next = { ...prev };
        for (const [brandId, res, ok] of results) {
          if (!ok) continue;
          next[brandId] = {
            ...next[brandId],
            ...Object.fromEntries(
              Object.entries(res).map(([keyword, entry]) => [keyword, entry.reposDiscovered]),
            ),
          };
        }
        return next;
      });
    });
  }

  useEffect(() => {
    loadStatus();
  }, []);

  // A stable string key, not the raw queue/status objects - status is a
  // brand-new object reference on every 2s poll tick even when nothing
  // meaningful changed, and using it directly as a dependency here used to
  // re-fire one GET per distinct company on every single tick (5 companies
  // queued meant ~150 requests/minute from this alone, comfortably enough
  // to trip the API's own 120-req/min throttle - see ThrottlerModule in
  // app.module.ts). Sorted + deduped so reordering the queue or a status
  // poll returning the same companies in a different order doesn't count
  // as "changed" either.
  const distinctBrandIdsKey = [
    ...new Set([
      ...queue.map((s) => s.brandId),
      ...(status?.slots.map((s) => s.brandId) ?? []),
    ]),
  ]
    .sort()
    .join(',');

  useEffect(() => {
    if (distinctBrandIdsKey) loadDiscoveredCounts(distinctBrandIdsKey.split(','));
  }, [distinctBrandIdsKey]);

  useEffect(() => {
    if (!status?.enabled) return;
    // 2s, not 5s - pause/resume/add/start/stop already update local state
    // instantly from their own response, but the countdown and any
    // server-side handoff (a slot's duration elapsing) should still show up
    // quickly without feeling like the page is lagging behind reality.
    pollRef.current = setInterval(loadStatus, 2000);
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    // Discovered-repo counts only need to be "reasonably fresh," not
    // second-by-second - a much slower, independent interval keeps them
    // updating over a long-running turn without adding to the fast 2s
    // status-poll's own request volume.
    const countsRef = setInterval(() => {
      if (distinctBrandIdsKey) loadDiscoveredCounts(distinctBrandIdsKey.split(','));
    }, 15_000);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(tickRef.current);
      clearInterval(countsRef);
    };
  }, [status?.enabled, distinctBrandIdsKey]);

  function moveQueueItem(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= queue.length) return;
    const next = [...queue];
    [next[index], next[target]] = [next[target], next[index]];
    onQueueChange(next);
  }

  function removeQueueItem(index: number) {
    onQueueChange(queue.filter((_, i) => i !== index));
  }

  /** Shared POST for both start actions below - only what slots to send differs between them. */
  async function runStart(slots: KeywordRotationSlot[], action: 'scan' | 'all') {
    setBusy(true);
    setBusyAction(action);
    setError('');
    try {
      const result = await api<KeywordRotationStatus>('/scans/keyword-rotation/start', {
        method: 'POST',
        body: JSON.stringify({
          slots,
          dateFilterMode: dateMode,
          ...(dateMode === 'dated' && from ? { createdFrom: from, pushedFrom: from } : {}),
          ...(dateMode === 'dated' && to ? { createdTo: to, pushedTo: to } : {}),
        }),
      });
      setStatus(result);
      onQueueChange([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start scheduler');
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  /**
   * Starts the scheduler with exactly `scanSlots` (see below the return
   * statement's data prep) - the already-unpaused configured keywords plus
   * anything newly staged in `queue`, i.e. what would actually run,
   * previewable via the "View keywords to start" disclosure before
   * committing.
   *
   * `previewSlots` (unpaused-only) is just for the empty-queue check - the
   * REAL payload sent is `payloadSlots`, which must include every
   * already-configured slot regardless of pause state (with its real
   * paused value preserved via toSlotInputPreservePaused). start() replaces
   * the whole rotation rather than merging into it
   * (KeywordRotationService.start), so leaving a paused slot out of the
   * payload here wouldn't just skip it - it would delete it from the queue
   * entirely. That was a real, shipped bug: adding one new keyword while
   * anything else was paused silently wiped every paused slot.
   */
  async function startScan(
    previewSlots: KeywordRotationSlot[],
    payloadSlots: KeywordRotationSlot[],
  ) {
    if (previewSlots.length === 0) {
      setError(
        'Nothing to start - every configured keyword is paused and nothing new is queued. Resume at least one, or use "Start all keywords."',
      );
      return;
    }
    await runStart(payloadSlots, 'scan');
  }

  /**
   * Starts the scheduler with EVERY configured keyword (paused or not) plus
   * anything newly staged in `queue` - un-pauses the whole queue in one go.
   */
  async function startAll() {
    const combined = [...(status?.slots.map(toSlotInput) ?? []), ...queue];
    if (combined.length === 0) {
      setError('Add at least one keyword to the queue first.');
      return;
    }
    await runStart(combined, 'all');
  }

  async function stop() {
    setBusy(true);
    setError('');
    try {
      const result = await api<KeywordRotationStatus>('/scans/keyword-rotation/stop', {
        method: 'POST',
      });
      setStatus(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to stop scheduler');
    } finally {
      setBusy(false);
    }
  }

  /** Appends everything currently staged to the END of an already-running scheduler, without touching whichever keyword currently holds the turn. See KeywordRotationService.addSlots. */
  async function addToRunning() {
    if (queue.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<KeywordRotationStatus>('/scans/keyword-rotation/add', {
        method: 'POST',
        body: JSON.stringify({ slots: queue }),
      });
      setStatus(result);
      onQueueChange([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add to the running queue');
    } finally {
      setBusy(false);
    }
  }

  /** Pauses/resumes exactly ONE keyword - the rest of the queue is untouched. See KeywordRotationService.pauseSlot/resumeSlot. If the whole rotation had stopped, resuming one keyword restarts just that one. */
  async function toggleSlot(brandId: string, keyword: string, pause: boolean) {
    setBusySlot(slotKey(brandId, keyword));
    setError('');
    try {
      const result = await api<KeywordRotationStatus>(
        `/scans/keyword-rotation/${pause ? 'pause' : 'resume'}`,
        { method: 'POST', body: JSON.stringify({ brandId, keyword }) },
      );
      setStatus(result);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to ${pause ? 'pause' : 'resume'} "${keyword}"`,
      );
    } finally {
      setBusySlot(null);
    }
  }

  /**
   * Changes which GitHub search kind(s) ONE already-queued keyword runs -
   * the rest of the queue is untouched. See
   * KeywordRotationService.setSlotSearchScope - if it's the slot currently
   * holding the turn, its scan restarts immediately with the new choice.
   */
  async function setSearchScope(
    brandId: string,
    keyword: string,
    searchScope: 'both' | 'repositories' | 'code',
  ) {
    setBusySlot(slotKey(brandId, keyword));
    setError('');
    try {
      const result = await api<KeywordRotationStatus>('/scans/keyword-rotation/search-scope', {
        method: 'POST',
        body: JSON.stringify({ brandId, keyword, searchScope }),
      });
      setStatus(result);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : `Failed to change search scope for "${keyword}"`,
      );
    } finally {
      setBusySlot(null);
    }
  }

  /** Updates one staged (not-yet-started) queue entry's search scope locally - no API call needed until Start/Add is actually clicked. */
  function setStagedSearchScope(index: number, searchScope: 'both' | 'repositories' | 'code') {
    const next = [...queue];
    next[index] = { ...next[index], searchScope };
    onQueueChange(next);
  }

  /**
   * Changes whether ONE already-queued keyword resumes its queries from its
   * own discovery cursor or restarts every query at page 1 every turn - the
   * rest of the queue is untouched. See
   * KeywordRotationService.setSlotContinueDiscovery - if it's the slot
   * currently holding the turn, its scan restarts immediately with the new
   * choice.
   */
  async function setContinueDiscovery(brandId: string, keyword: string, continueDiscovery: boolean) {
    setBusySlot(slotKey(brandId, keyword));
    setError('');
    try {
      const result = await api<KeywordRotationStatus>('/scans/keyword-rotation/continue-discovery', {
        method: 'POST',
        body: JSON.stringify({ brandId, keyword, continueDiscovery }),
      });
      setStatus(result);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to change discovery pagination for "${keyword}"`,
      );
    } finally {
      setBusySlot(null);
    }
  }

  /** Updates one staged (not-yet-started) queue entry's discovery-pagination choice locally - no API call needed until Start/Add is actually clicked. */
  function setStagedContinueDiscovery(index: number, continueDiscovery: boolean) {
    const next = [...queue];
    next[index] = { ...next[index], continueDiscovery };
    onQueueChange(next);
  }

  /** Permanently removes exactly ONE keyword from the queue, from any state. See KeywordRotationService.removeSlot - if it's the slot currently holding the turn, its scan is cancelled and the next non-paused one picks up immediately. */
  async function removeSlot(brandId: string, keyword: string) {
    if (!window.confirm(`Remove "${keyword}" from the scheduler queue? This can't be undone.`)) {
      return;
    }
    setBusySlot(slotKey(brandId, keyword));
    setError('');
    try {
      const result = await api<KeywordRotationStatus>('/scans/keyword-rotation/remove', {
        method: 'POST',
        body: JSON.stringify({ brandId, keyword }),
      });
      setStatus(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to remove "${keyword}"`);
    } finally {
      setBusySlot(null);
    }
  }

  const isRunning = !!status?.enabled;
  const hasConfiguredSlots = !!status && status.slots.length > 0;
  const remainingMs =
    isRunning && status?.slotEndsAt
      ? Math.max(0, new Date(status.slotEndsAt).getTime() - now)
      : 0;
  // What "Start the scan" would actually RUN - every already-unpaused
  // configured keyword, plus anything newly staged. Drives the preview
  // disclosure, the button's own count, and its disabled state.
  const scanPreviewSlots: KeywordRotationSlot[] = [
    ...(status?.slots.filter((s) => !s.paused).map(toSlotInput) ?? []),
    ...queue,
  ];
  // What actually gets SENT when "Start the scan" is clicked - every
  // configured slot, paused or not (with its real paused value preserved),
  // plus anything newly staged. Must include the paused ones too, or
  // start() (a full replace, not a merge) would delete them outright - see
  // toSlotInputPreservePaused.
  const scanPayloadSlots: KeywordRotationSlot[] = [
    ...(status?.slots.map(toSlotInputPreservePaused) ?? []),
    ...queue,
  ];

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4">
        <div>
          <h3 className="text-base font-semibold">Sequential scheduler</h3>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={isRunning ? 'accent' : 'muted'} dot={isRunning} className="tracking-wide">
            {isRunning ? 'RUNNING' : 'OFF'}
          </Badge>
          {onRefreshScans ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefreshScans}
              title="Refresh the Currently running scans table below"
            >
              Refresh
            </Button>
          ) : null}
          {isRunning ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={stop}
              disabled={busy}
              title="Stop the whole scheduler - every keyword, not just one"
            >
              Stop scheduler
            </Button>
          ) : null}
        </div>
      </div>

      <div className="p-4">
        {status?.lastError ? (
          <p className="mb-3 text-xs text-[var(--danger)]">{status.lastError}</p>
        ) : null}

        {hasConfiguredSlots && status ? (
          <>
            {isRunning ? (
              <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Card className="px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                    Now running
                  </p>
                  <p className="mt-1 text-lg font-semibold font-[family-name:var(--font-mono)]">
                    {status.currentKeyword ?? '—'}
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    {(status.currentBrandId && brandNameById.get(status.currentBrandId)) ?? ''}
                  </p>
                </Card>
                <Card className="px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                    Next handoff in
                  </p>
                  <p className="mt-1 text-lg font-semibold">{formatHms(remainingMs)}</p>
                  {status.waitingOnQuota ? (
                    <span title="This keyword's scan is paused waiting on GitHub's rate limit or daily quota - its slot is being extended instead of cut off having made no progress, up to a few times before handing off anyway.">
                      <Badge tone="warning" className="mt-1.5">
                        Waiting on GitHub quota
                      </Badge>
                    </span>
                  ) : null}
                </Card>
                <Card className="px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                    Cycles completed
                  </p>
                  <p className="mt-1 text-lg font-semibold">{status.cyclesCompleted}</p>
                </Card>
              </div>
            ) : (
              <p className="mb-2 text-xs text-[var(--muted)]">
                Scheduler is off - the queue below is still here. Resume a keyword individually, or
                click &quot;Start scheduler&quot; below to run everything again.
              </p>
            )}

            <ol className="flex flex-col gap-1.5">
              {status.slots.map((slot, i) => (
                <li
                  key={`${slot.brandId}-${slot.keyword}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
                  style={{
                    background:
                      isRunning && i === status.currentIndex ? 'var(--accent-soft)' : 'var(--bg)',
                    borderColor:
                      isRunning && i === status.currentIndex
                        ? 'var(--accent-border)'
                        : 'var(--border)',
                  }}
                >
                  <span className="w-5 text-center text-[var(--muted)]">{i + 1}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {brandNameById.get(slot.brandId) ?? 'Unknown company'}
                  </span>
                  <span className="min-w-0 flex-1 break-words font-[family-name:var(--font-mono)]">
                    {slot.keyword}
                    {slot.paused ? (
                      <Badge tone="warning" className="ml-1.5 font-sans">
                        PAUSED
                      </Badge>
                    ) : null}
                  </span>
                  <span
                    className="text-xs text-[var(--muted)]"
                    title="Repos discovered - lifetime total for this keyword"
                  >
                    {discoveredCounts[slot.brandId]?.[slot.keyword] ?? 0} discovered
                  </span>
                  <Link
                    href={`/repositories?brandId=${slot.brandId}&brandName=${encodeURIComponent(brandNameById.get(slot.brandId) ?? '')}&keyword=${encodeURIComponent(slot.keyword)}`}
                    className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--accent)] hover:border-[var(--accent)]"
                  >
                    View
                  </Link>
                  <span className="text-xs text-[var(--muted)]">{formatHms(slot.durationMs)}</span>
                  <SearchScopeToggle
                    value={slot.searchScope ?? 'both'}
                    busy={busySlot === slotKey(slot.brandId, slot.keyword)}
                    onChange={(next) => setSearchScope(slot.brandId, slot.keyword, next)}
                  />
                  <DiscoveryPaginationToggle
                    value={slot.continueDiscovery ?? true}
                    busy={busySlot === slotKey(slot.brandId, slot.keyword)}
                    onChange={(next) => setContinueDiscovery(slot.brandId, slot.keyword, next)}
                  />
                  <Toggle
                    on={!slot.paused}
                    busy={busySlot === slotKey(slot.brandId, slot.keyword)}
                    onOn={() => toggleSlot(slot.brandId, slot.keyword, false)}
                    onOff={() => toggleSlot(slot.brandId, slot.keyword, true)}
                    onTitle="Pause this keyword - the rest of the queue keeps running"
                    offTitle="Resume this keyword"
                  />
                  <button
                    type="button"
                    onClick={() => removeSlot(slot.brandId, slot.keyword)}
                    disabled={busySlot === slotKey(slot.brandId, slot.keyword)}
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--danger)] disabled:opacity-40"
                    title="Remove this keyword from the queue permanently"
                    aria-label={`Remove "${slot.keyword}" from the queue permanently`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="mb-3 rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center">
            <p className="text-sm font-medium text-[var(--muted)]">Not started</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              No keyword selected yet - pick one below (or add a new one) to start the scheduler.
            </p>
          </div>
        )}

        <div className={hasConfiguredSlots ? 'mt-4 border-t border-[var(--border)] pt-3' : ''}>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-[var(--muted)]">
              {hasConfiguredSlots ? 'Add more keywords' : 'Build your queue'}
            </p>
            {/* Actually adding a keyword happens in the "Start a manual
                scan" card's Schedule column below (KeywordScanner) - this
                widget only displays/reorders/starts whatever's staged there.
                Always shown, including while running with nothing staged
                yet, so there's a real way in rather than a dead-end label. */}
            <Link
              href="#start-manual-scan"
              className="shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
            >
              + Add keyword
            </Link>
          </div>
          {queue.length === 0 ? null : (
            <ol className="flex flex-col gap-1.5">
              {queue.map((slot, i) => (
                <li
                  key={`${slot.brandId}-${slot.keyword}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
                >
                  <span className="w-5 text-center text-[var(--muted)]">{i + 1}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {brandNameById.get(slot.brandId) ?? 'Unknown company'}
                  </span>
                  <span className="min-w-0 flex-1 break-words font-[family-name:var(--font-mono)]">
                    {slot.keyword}
                  </span>
                  <span
                    className="text-xs text-[var(--muted)]"
                    title="Repos discovered - lifetime total for this keyword"
                  >
                    {discoveredCounts[slot.brandId]?.[slot.keyword] ?? 0} discovered
                  </span>
                  <Link
                    href={`/repositories?brandId=${slot.brandId}&brandName=${encodeURIComponent(brandNameById.get(slot.brandId) ?? '')}&keyword=${encodeURIComponent(slot.keyword)}`}
                    className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--accent)] hover:border-[var(--accent)]"
                  >
                    View
                  </Link>
                  <span className="text-xs text-[var(--muted)]">{formatHms(slot.durationMs)}</span>
                  <SearchScopeToggle
                    value={slot.searchScope ?? 'both'}
                    busy={false}
                    onChange={(next) => setStagedSearchScope(i, next)}
                  />
                  <DiscoveryPaginationToggle
                    value={slot.continueDiscovery ?? true}
                    busy={false}
                    onChange={(next) => setStagedContinueDiscovery(i, next)}
                  />
                  <button
                    type="button"
                    onClick={() => moveQueueItem(i, -1)}
                    disabled={i === 0}
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs disabled:opacity-30"
                    title="Move earlier"
                    aria-label={`Move "${slot.keyword}" earlier in the queue`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveQueueItem(i, 1)}
                    disabled={i === queue.length - 1}
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs disabled:opacity-30"
                    title="Move later"
                    aria-label={`Move "${slot.keyword}" later in the queue`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQueueItem(i)}
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--danger)]"
                    title="Remove from queue"
                    aria-label={`Remove "${slot.keyword}" from the staged queue`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          )}

          {isRunning ? (
            queue.length > 0 ? (
              <Button type="button" size="sm" onClick={addToRunning} loading={busy} className="mt-2">
                {busy ? 'Adding…' : `+ Add ${queue.length} to running queue`}
              </Button>
            ) : null
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <div className="inline-flex rounded-lg border border-[var(--border)] p-0.5">
                  <button
                    type="button"
                    onClick={() => setDateMode('any')}
                    className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150"
                    style={{
                      background: dateMode === 'any' ? 'var(--accent)' : 'transparent',
                      color: dateMode === 'any' ? 'white' : 'var(--muted)',
                    }}
                  >
                    Any date
                  </button>
                  <button
                    type="button"
                    onClick={() => setDateMode('dated')}
                    className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150"
                    style={{
                      background: dateMode === 'dated' ? 'var(--accent)' : 'transparent',
                      color: dateMode === 'dated' ? 'white' : 'var(--muted)',
                    }}
                  >
                    Filter by dates
                  </button>
                </div>
                {dateMode === 'dated' ? (
                  <div className="flex items-center gap-2 text-xs">
                    <input
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1"
                    />
                    <span className="text-[var(--muted)]">to</span>
                    <input
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1"
                    />
                    <span className="text-[10px] text-[var(--muted)]">
                      Applied to every newly-queued keyword
                    </span>
                  </div>
                ) : null}
              </div>
              {hasConfiguredSlots || queue.length > 0 ? (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setScanPreviewOpen((v) => !v)}
                    className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
                    aria-expanded={scanPreviewOpen}
                  >
                    {scanPreviewOpen ? (
                      <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    )}
                    View keyword{scanPreviewSlots.length === 1 ? '' : 's'} to start (
                    {scanPreviewSlots.length})
                  </button>
                  {scanPreviewOpen ? (
                    <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2">
                      {scanPreviewSlots.length === 0 ? (
                        <p className="px-1 py-0.5 text-xs text-[var(--muted)]">
                          Nothing would start - every configured keyword is paused and nothing new
                          is queued.
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {scanPreviewSlots.map((s, i) => (
                            <li
                              key={`${s.brandId}-${s.keyword}-${i}`}
                              className="flex flex-wrap items-center gap-2 px-1 py-0.5 text-xs"
                            >
                              <span className="text-[var(--muted)]">
                                {brandNameById.get(s.brandId) ?? 'Unknown company'}
                              </span>
                              <span className="font-[family-name:var(--font-mono)]">
                                {s.keyword}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => startScan(scanPreviewSlots, scanPayloadSlots)}
                      loading={busy && busyAction === 'scan'}
                      disabled={busy || scanPreviewSlots.length === 0}
                      title="Starts every already-unpaused configured keyword, plus anything just added below - paused keywords stay paused, not deleted"
                    >
                      {busy && busyAction === 'scan' ? 'Starting…' : 'Start the scan'}
                    </Button>
                    {hasConfiguredSlots ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={startAll}
                        loading={busy && busyAction === 'all'}
                        disabled={busy}
                        title="Starts every configured keyword, including paused ones, plus anything just added below"
                      >
                        {busy && busyAction === 'all'
                          ? 'Starting…'
                          : `Start all keywords (${(status?.slots.length ?? 0) + queue.length})`}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {error ? <p className="px-4 pb-4 text-xs text-[var(--danger)]">{error}</p> : null}
      {loadError ? <p className="px-4 pb-4 text-xs text-[var(--warning)]">{loadError}</p> : null}
    </Card>
  );
}
