'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Input, SegmentedControl } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { api, Brand } from '@/lib/api';

interface ActiveKeywordScan {
  scanJobId: string;
  status: string;
  /** True iff this keyword's MOST RECENT run is still queued/running - the toggle's actual on/off state. */
  isActive: boolean;
  startedAt?: string;
  /** Cumulative across EVERY run of this keyword, not just the current one - stays put after you turn it off. */
  reposDiscovered: number;
  reposPendingAnalysis: number;
  /** Set while this scan is mid GitHub rate-limit pacing delay - still genuinely running, just waiting on its next request slot. */
  pausedUntil?: number;
  /** Why the most recent run finished, once it has - e.g. "Analyzed 0 repositories" (legitimately found nothing new) vs a real error. Only set once off. */
  lastMessage?: string;
  lastError?: string;
  /** Set while QUEUED means "deliberately cooling down before the next automatic watch cycle" - not a worker backlog. See maybeRestartKeywordWatch. */
  scheduledFor?: number;
}

type ActiveByKeyword = Record<string, ActiveKeywordScan>;

interface QueryPair {
  repoQuery: string;
  codeQuery: string;
}

type QueryPreviews = Record<string, QueryPair>;

interface DateRange {
  from: string;
  to: string;
}

type KeywordDates = Record<string, DateRange>;

/** 'dated' = restrict to the from/to range below; 'any' = no created/pushed restriction at all, matching a plain GitHub search. */
type DateFilterMode = 'dated' | 'any';
type KeywordDateModes = Record<string, DateFilterMode>;

/** mm:ss, or hh:mm:ss once it runs past an hour. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

interface Hms {
  h: number;
  m: number;
  s: number;
}

const DEFAULT_HMS: Hms = { h: 0, m: 5, s: 0 };

function hmsToMs(hms: Hms): number {
  return ((hms.h * 3600 + hms.m * 60 + hms.s) * 1000);
}

/** hh:mm:ss duration picker for the sequential scheduler queue - see KeywordScheduleQueue. */
function HmsPicker({
  value,
  onChange,
  disabled,
}: {
  value: Hms;
  onChange: (next: Hms) => void;
  disabled?: boolean;
}) {
  const field = (key: keyof Hms, max: number) => (
    <input
      type="number"
      min={0}
      max={max}
      value={value[key]}
      disabled={disabled}
      onChange={(e) =>
        onChange({ ...value, [key]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })
      }
      className="w-14 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1.5 text-center text-xs disabled:opacity-60"
    />
  );
  return (
    <div className="flex items-center gap-0.5">
      {field('h', 23)}
      <span className="text-xs text-[var(--muted)]">h</span>
      {field('m', 59)}
      <span className="text-xs text-[var(--muted)]">m</span>
      {field('s', 59)}
      <span className="text-xs text-[var(--muted)]">s</span>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: 'off' | 'queued' | 'running' | 'paused' | 'cooldown';
}) {
  const config: Record<string, { tone: BadgeTone; label: string; dot?: boolean }> = {
    off: { tone: 'muted', label: 'OFF' },
    queued: { tone: 'warning', label: 'QUEUED', dot: true },
    running: { tone: 'accent', label: 'RUNNING', dot: true },
    paused: { tone: 'warning', label: 'PACED', dot: true },
    cooldown: { tone: 'accent', label: 'WATCHING' },
  };
  const c = config[status];
  return (
    <Badge tone={c.tone} dot={c.dot} className="tracking-wide">
      {c.label}
    </Badge>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
    </Card>
  );
}

/**
 * Per-keyword discovery toggle for one brand: start/stop an independent,
 * long-running "discover only" watch for exactly one keyword at a time -
 * several keywords can be toggled on at once (each its own scan, its own
 * budget, no interference between them). A keyword stays "on" until YOU
 * turn it off - exhausting the current results doesn't stop it; the
 * backend (ScanStateService.maybeRestartKeywordWatch) automatically
 * re-runs it after a cooldown so it keeps effectively watching for new
 * matches over time, resuming from its own discovery cursor each cycle.
 * `from`/`to` seed the
 * INITIAL date range for every keyword the first time it's seen, but each
 * keyword's date range is then fully independent - editing one keyword's
 * dates re-generates only that keyword's own query and has no effect on
 * any other keyword, so different keywords can search different date
 * windows entirely on their own. Reflects true server-side state on load
 * (GET /scans/active-by-keyword), not just whatever this browser tab
 * remembers, so a reload or a second tab both show the same running state
 * and timer.
 *
 * Below each keyword, the actual repo-search and code-search query strings
 * GitHub will be sent (from GET /scans/keyword-query-preview) are shown in
 * an editable field, with that keyword's own date range baked directly
 * into the query text - if the auto-generated query looks wrong or too
 * narrow, edit it right there before starting; the edited text is sent
 * verbatim as that keyword's query instead of the auto-generated one.
 */
export function KeywordScanner({
  brand,
  from,
  to,
  onBrandUpdate,
  onQueue,
}: {
  brand: Brand;
  from: string;
  to: string;
  onBrandUpdate: (updated: Brand) => void;
  /** Adds this keyword (with the duration picked in the Schedule column) to the sequential scheduler's queue - see KeywordScheduleQueue at the top of the page. */
  onQueue?: (keyword: string, durationMs: number) => void;
}) {
  const [active, setActive] = useState<ActiveByKeyword>({});
  const [scheduleHms, setScheduleHms] = useState<Record<string, Hms>>({});
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  // Separate from `error` (which reports the result of a deliberate user
  // action, e.g. "add keyword") - this covers background fetches
  // (loadActive/loadPreviews/refreshKeywordPreview) so a transient network
  // blip doesn't silently look like "nothing to show" or "still loading
  // forever", without clobbering an unrelated action-result message that
  // happened to be showing at the same moment.
  const [loadError, setLoadError] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [addingKeyword, setAddingKeyword] = useState(false);
  const [filter, setFilter] = useState('');
  const [previews, setPreviews] = useState<QueryPreviews>({});
  const [drafts, setDrafts] = useState<QueryPreviews>({});
  const [dates, setDates] = useState<KeywordDates>({});
  const [dateModes, setDateModes] = useState<KeywordDateModes>({});
  // Remembers a keyword's last "Filter by dates" range while it's switched to
  // "Any date", so flipping back to "Filter by dates" restores it instead of
  // making the user re-pick both dates from scratch.
  const [savedDates, setSavedDates] = useState<KeywordDates>({});

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  function loadActive() {
    api<ActiveByKeyword>(`/scans/active-by-keyword?brandId=${brand._id}`)
      .then((res) => {
        setActive(res);
        setLoadError('');
      })
      .catch(() => setLoadError('Failed to load keyword status - retrying automatically.'));
  }

  function loadPreviews() {
    const params = new URLSearchParams({ brandId: brand._id });
    if (from) {
      params.set('createdFrom', from);
      params.set('pushedFrom', from);
    }
    if (to) {
      params.set('createdTo', to);
      params.set('pushedTo', to);
    }
    api<QueryPreviews>(`/scans/keyword-query-preview?${params}`)
      .then((res) => {
        setPreviews(res);
        // Only reset a keyword's draft/dates if the user hasn't already got
        // one open for it - an in-progress edit shouldn't get silently
        // wiped by a routine background refresh, and a keyword whose date
        // range has already been individually customized must keep it.
        setDrafts((prev) => {
          const next = { ...prev };
          for (const [keyword, pair] of Object.entries(res)) {
            if (!next[keyword]) next[keyword] = pair;
          }
          return next;
        });
        setDates((prev) => {
          const next = { ...prev };
          for (const keyword of Object.keys(res)) {
            if (!next[keyword]) next[keyword] = { from, to };
          }
          return next;
        });
        setDateModes((prev) => {
          const next = { ...prev };
          for (const keyword of Object.keys(res)) {
            if (!next[keyword]) next[keyword] = from || to ? 'dated' : 'any';
          }
          return next;
        });
        setLoadError('');
      })
      .catch(() =>
        setLoadError('Failed to load query previews - the queries shown below may be stale.'),
      );
  }

  /**
   * Re-generates just ONE keyword's own repo/code query for its own
   * (possibly just-edited) date range, independently of every other
   * keyword - the single-keyword variant of loadPreviews. Always
   * overwrites that keyword's draft: changing its date range is a
   * deliberate "give me a fresh query for this new window" action, not a
   * background refresh that should respect a manual text edit.
   */
  function refreshKeywordPreview(keyword: string, range: DateRange) {
    const params = new URLSearchParams({ brandId: brand._id, keyword });
    if (range.from) {
      params.set('createdFrom', range.from);
      params.set('pushedFrom', range.from);
    }
    if (range.to) {
      params.set('createdTo', range.to);
      params.set('pushedTo', range.to);
    }
    api<QueryPreviews>(`/scans/keyword-query-preview?${params}`)
      .then((res) => {
        const pair = res[keyword];
        if (!pair) return;
        setPreviews((prev) => ({ ...prev, [keyword]: pair }));
        setDrafts((prev) => ({ ...prev, [keyword]: pair }));
        setLoadError('');
      })
      .catch(() => setLoadError(`Failed to update the query preview for "${keyword}".`));
  }

  function setKeywordDate(keyword: string, field: 'from' | 'to', value: string) {
    const current = dates[keyword] ?? { from, to };
    const nextRange = { ...current, [field]: value };
    setDates((prev) => ({ ...prev, [keyword]: nextRange }));
    refreshKeywordPreview(keyword, nextRange);
  }

  /**
   * Switches one keyword between "Filter by dates" (its from/to range below
   * applies) and "Any date" (no created/pushed restriction at all - matches
   * repos from any time, same as typing the keyword straight into GitHub's
   * own search box). Switching to "Any date" clears the query's date
   * qualifiers immediately rather than just hiding the inputs, so a
   * previously-set range can never silently leak into the next scan. The
   * range itself is remembered in savedDates so switching back to "Filter by
   * dates" restores it instead of starting blank.
   */
  function setKeywordDateMode(keyword: string, mode: DateFilterMode) {
    setDateModes((prev) => ({ ...prev, [keyword]: mode }));
    if (mode === 'any') {
      const current = dates[keyword];
      if (current && (current.from || current.to)) {
        setSavedDates((prev) => ({ ...prev, [keyword]: current }));
      }
      const empty: DateRange = { from: '', to: '' };
      setDates((prev) => ({ ...prev, [keyword]: empty }));
      refreshKeywordPreview(keyword, empty);
    } else {
      const restored = savedDates[keyword] ?? dates[keyword] ?? { from: '', to: '' };
      setDates((prev) => ({ ...prev, [keyword]: restored }));
      refreshKeywordPreview(keyword, restored);
    }
  }

  useEffect(() => {
    loadActive();
    loadPreviews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand._id, from, to]);

  const anyActive = Object.values(active).some((e) => e.isActive);

  useEffect(() => {
    // Only poll while something is actually queued/running - with nothing
    // active there's nothing that could change on its own, so repeatedly
    // hitting the API would just be dead weight. The moment a keyword is
    // turned on this effect re-runs and starts polling; turning the last one
    // off stops it again. 2s (not the original 6s) so the Status/Running
    // for/Discovered columns don't lag noticeably behind what the sequential
    // scheduler is actually doing to this same keyword in the background.
    if (!anyActive) return;
    pollRef.current = setInterval(loadActive, 2000);
    // Refreshes running counts and - importantly - notices when a scan has
    // naturally finished (exhausted its queries) so that keyword's toggle
    // flips back to "off" on its own instead of showing "running" forever.
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyActive]);

  function setDraft(keyword: string, field: 'repoQuery' | 'codeQuery', value: string) {
    setDrafts((prev) => ({
      ...prev,
      [keyword]: {
        repoQuery: prev[keyword]?.repoQuery ?? previews[keyword]?.repoQuery ?? '',
        codeQuery: prev[keyword]?.codeQuery ?? previews[keyword]?.codeQuery ?? '',
        [field]: value,
      },
    }));
  }

  function resetDraft(keyword: string) {
    if (previews[keyword]) {
      setDrafts((prev) => ({ ...prev, [keyword]: previews[keyword] }));
    }
  }

  async function addKeyword() {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    if (brand.keywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      setNewKeyword('');
      return;
    }
    setAddingKeyword(true);
    setError('');
    try {
      const updated = await api<Brand>(`/brands/${brand._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ keywords: [...brand.keywords, trimmed] }),
      });
      onBrandUpdate(updated);
      setNewKeyword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add keyword');
    } finally {
      setAddingKeyword(false);
    }
  }

  const runningCount = Object.values(active).filter((e) => e.isActive).length;
  // Cumulative across every keyword's every run (see listActiveByKeyword) -
  // deliberately NOT filtered to isActive, so turning a keyword off doesn't
  // make its already-discovered repos disappear from this total.
  const totalDiscovered = Object.values(active).reduce(
    (sum, e) => sum + e.reposDiscovered,
    0,
  );
  const visibleKeywords = brand.keywords.filter((k) =>
    k.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <Card>
      <div className="border-b border-[var(--border)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Keyword scanner — {brand.name}</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              loadActive();
              loadPreviews();
            }}
          >
            Refresh
          </Button>
        </div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Turn a keyword on to start watching for repos that match it (name/description/code) - it
          stays on until you turn it off, automatically re-checking for new matches over time even
          after it runs out of results right now. Several keywords can run at once with no
          interference between them; a repo already found by one is never re-counted by another.
          The exact repo-search and code-search query below each keyword is editable - fix it
          before starting if it looks wrong or too narrow.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <StatTile label="Keywords" value={brand.keywords.length} />
        <StatTile label="Running now" value={runningCount} />
        <StatTile label="Discovered" value={totalDiscovered} />
      </div>

      <div className="px-4 pb-3">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search keywords…"
          className="w-full max-w-xs py-1.5"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[640px] w-full text-sm">
          <thead className="bg-[var(--bg-subtle)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
            <tr>
              <th className="px-4 py-2">Keyword</th>
              <th className="px-4 py-2">Schedule</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Running for</th>
              <th className="px-4 py-2">Discovered</th>
            </tr>
          </thead>
          <tbody>
            {visibleKeywords.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-[var(--muted)]">
                  {brand.keywords.length === 0
                    ? 'No keywords yet - add one below.'
                    : 'No keywords match your search.'}
                </td>
              </tr>
            ) : (
              visibleKeywords.map((keyword) => {
                const entry = active[keyword];
                const isRunning = !!entry?.isActive;
                const isPaused = !!entry?.pausedUntil && entry.pausedUntil > now;
                const isCoolingDown = !!entry?.scheduledFor && entry.scheduledFor > now;
                const status: 'off' | 'queued' | 'running' | 'paused' | 'cooldown' =
                  !isRunning
                    ? 'off'
                    : isCoolingDown
                      ? 'cooldown'
                      : isPaused
                        ? 'paused'
                        : entry.status === 'queued'
                          ? 'queued'
                          : 'running';
                const elapsedMs = entry?.startedAt
                  ? now - new Date(entry.startedAt).getTime()
                  : 0;
                const draft = drafts[keyword];
                const preview = previews[keyword];
                const dateMode: DateFilterMode =
                  dateModes[keyword] ?? (from || to ? 'dated' : 'any');
                const repoEdited =
                  draft && preview && draft.repoQuery.trim() !== preview.repoQuery.trim();
                const codeEdited =
                  draft && preview && draft.codeQuery.trim() !== preview.codeQuery.trim();
                return (
                  <Fragment key={keyword}>
                    <tr className="border-t border-[var(--border)] transition-colors duration-150 hover:bg-[var(--bg-subtle)]">
                      <td className="px-4 py-2.5 font-[family-name:var(--font-mono)]">
                        {keyword}
                        {status === 'off' && (entry?.lastError || entry?.lastMessage) ? (
                          <p
                            className="mt-0.5 max-w-[16rem] truncate text-xs font-sans normal-case"
                            style={{ color: entry?.lastError ? 'var(--danger)' : 'var(--muted)' }}
                            title={entry?.lastError || entry?.lastMessage}
                          >
                            {entry?.lastError ? `Last run failed: ${entry.lastError}` : entry?.lastMessage}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        {onQueue ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <HmsPicker
                              value={scheduleHms[keyword] ?? DEFAULT_HMS}
                              onChange={(next) =>
                                setScheduleHms((prev) => ({ ...prev, [keyword]: next }))
                              }
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const hms = scheduleHms[keyword] ?? DEFAULT_HMS;
                                const durationMs = hmsToMs(hms);
                                if (durationMs <= 0) return;
                                onQueue(keyword, durationMs);
                              }}
                              className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:border-[var(--accent)]"
                              title="Add this keyword to the sequential scheduler's queue with the duration above"
                            >
                              Next →
                            </button>
                          </div>
                        ) : (
                          <span className="text-[var(--muted)]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-2.5 text-[var(--muted)]">
                        {status === 'cooldown'
                          ? `next check in ${formatElapsed((entry?.scheduledFor ?? now) - now)}`
                          : status === 'paused'
                            ? `resumes in ${formatElapsed((entry?.pausedUntil ?? now) - now)}`
                            : status === 'running'
                              ? formatElapsed(elapsedMs)
                              : '—'}
                      </td>
                      <td className="px-4 py-2.5">{entry?.reposDiscovered ?? 0}</td>
                    </tr>
                    <tr className="border-t border-[var(--border)]/50">
                      <td />
                      <td colSpan={4} className="px-4 pb-3 pt-0">
                        {draft ? (
                          <div className="grid gap-1.5 sm:grid-cols-[3rem_1fr] sm:items-start">
                            <span className="text-xs uppercase tracking-wide text-[var(--muted)] sm:pt-1.5">
                              dates
                            </span>
                            <div className="flex flex-wrap items-center gap-2">
                              <span title="Search repos from any time - no date restriction, closest to a plain GitHub search / Restrict this keyword to a specific created/pushed date range">
                                <SegmentedControl
                                  value={dateMode}
                                  onChange={(v) => setKeywordDateMode(keyword, v)}
                                  disabled={isRunning}
                                  options={[
                                    { value: 'any', label: 'Any date' },
                                    { value: 'dated', label: 'Filter by dates' },
                                  ]}
                                />
                              </span>
                              {dateMode === 'dated' ? (
                                <>
                                  <input
                                    type="date"
                                    value={dates[keyword]?.from ?? ''}
                                    disabled={isRunning}
                                    onChange={(e) => setKeywordDate(keyword, 'from', e.target.value)}
                                    className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs disabled:opacity-60"
                                    title="This keyword's own 'from' date - independent of every other keyword"
                                  />
                                  <span className="text-xs text-[var(--muted)]">to</span>
                                  <input
                                    type="date"
                                    value={dates[keyword]?.to ?? ''}
                                    disabled={isRunning}
                                    onChange={(e) => setKeywordDate(keyword, 'to', e.target.value)}
                                    className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs disabled:opacity-60"
                                    title="This keyword's own 'to' date - independent of every other keyword"
                                  />
                                  <span className="text-xs text-[var(--muted)]">
                                    (baked into the query below - matches repos created OR pushed in
                                    this range)
                                  </span>
                                </>
                              ) : (
                                <span className="text-xs text-[var(--muted)]">
                                  No date restriction - matches repos from any time.
                                </span>
                              )}
                            </div>
                            <span className="text-xs uppercase tracking-wide text-[var(--muted)] sm:pt-1.5">
                              repo
                            </span>
                            <input
                              value={draft.repoQuery}
                              disabled={isRunning}
                              onChange={(e) => setDraft(keyword, 'repoQuery', e.target.value)}
                              className="w-full rounded border px-2 py-1 font-[family-name:var(--font-mono)] text-xs disabled:opacity-60"
                              style={{
                                borderColor: repoEdited ? 'var(--accent)' : 'var(--border)',
                                background: 'var(--bg)',
                              }}
                            />
                            <span className="text-xs uppercase tracking-wide text-[var(--muted)] sm:pt-1.5">
                              code
                            </span>
                            <input
                              value={draft.codeQuery}
                              disabled={isRunning}
                              onChange={(e) => setDraft(keyword, 'codeQuery', e.target.value)}
                              className="w-full rounded border px-2 py-1 font-[family-name:var(--font-mono)] text-xs disabled:opacity-60"
                              style={{
                                borderColor: codeEdited ? 'var(--accent)' : 'var(--border)',
                                background: 'var(--bg)',
                              }}
                            />
                            {(repoEdited || codeEdited) && !isRunning ? (
                              <div className="sm:col-start-2">
                                <button
                                  type="button"
                                  onClick={() => resetDraft(keyword)}
                                  className="text-xs text-[var(--accent)] hover:underline"
                                >
                                  Reset to auto-generated
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <p className="text-xs text-[var(--muted)]">Loading query preview…</p>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--border)] p-4">
        <Input
          value={newKeyword}
          onChange={(e) => setNewKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addKeyword();
            }
          }}
          placeholder="Add a new keyword…"
          className="flex-1 py-1.5"
        />
        <Button
          type="button"
          variant="outline"
          onClick={addKeyword}
          disabled={addingKeyword || !newKeyword.trim()}
        >
          {addingKeyword ? 'Adding…' : '+ Add keyword'}
        </Button>
      </div>

      {error ? <p className="px-4 pb-4 text-xs text-[var(--danger)]">{error}</p> : null}
      {loadError ? <p className="px-4 pb-4 text-xs text-[var(--warning)]">{loadError}</p> : null}
    </Card>
  );
}
