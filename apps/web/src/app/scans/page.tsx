'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Globe, Lock } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Select,
  TableSkeleton,
} from '@/components/ui';
import { KeywordScanner } from '@/components/KeywordScanner';
import { KeywordScheduleQueue } from '@/components/KeywordScheduleQueue';
import { api, Brand, KeywordRotationSlot, Paginated, ScanJob } from '@/lib/api';
import { formatDateTime } from '@/lib/date';

type ScanModeOption =
  | 'incremental'
  | 'analyze_pending'
  | 'reanalyze_existing'
  | 'backfill_ai';
/** External-scan scope: how to find candidate repos. Internal audits skip this entirely - they always target one brand's own accounts. */
type ExternalScopeOption = 'all' | 'brand' | 'query';
/** The primary choice this whole page exists to make explicit - see the two buttons below. `null` = not yet chosen. */
type ScanKind = 'internal' | 'external' | null;

const ACTIVE_STATUSES = ['queued', 'running'];
/** Scoping keywords beyond this length get truncated with a click-to-expand modal - see ScanTable. */
const KEYWORD_PREVIEW_LEN = 24;

function ScanStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'queued'
      ? 'warning'
      : status === 'running'
        ? 'accent'
        : status === 'failed'
          ? 'danger'
          : 'muted';
  return (
    <Badge tone={tone} dot={ACTIVE_STATUSES.includes(status)} className="capitalize tracking-wide">
      {status.replaceAll('_', ' ')}
    </Badge>
  );
}

/** Shared row/table rendering for both the top "currently running" view and the full scan history below - same columns, different row sets. */
function ScanTable({
  rows,
  brandNameById,
  cancellingId,
  onCancel,
}: {
  rows: ScanJob[];
  brandNameById: Map<string, string>;
  cancellingId: string | null;
  onCancel: (id: string) => void;
}) {
  // Some scoping keywords are full free-text search queries rather than
  // short tags - truncated inline (see KEYWORD_PREVIEW_LEN) with a click to
  // reveal the rest, instead of letting a long one wrap and blow out the
  // row height for every column in that row.
  const [expandedKeyword, setExpandedKeyword] = useState<{
    company: string;
    text: string;
  } | null>(null);

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)]">
      <table className="w-full table-fixed text-xs sm:text-sm">
        <thead className="bg-[var(--bg-subtle)] text-left text-[var(--muted)]">
          <tr>
            <th className="w-[9%] px-2 py-2.5 sm:px-3">Type</th>
            <th className="w-[17%] px-2 py-2.5 sm:px-3">Company / Keyword</th>
            <th className="w-[9%] px-2 py-2.5 sm:px-3">Mode</th>
            <th className="w-[8%] px-2 py-2.5 sm:px-3">Status</th>
            <th className="w-[13%] px-2 py-2.5 sm:px-3">Repos</th>
            <th className="w-[15%] px-2 py-2.5 sm:px-3">Skip / Rescan</th>
            <th className="w-[8%] px-2 py-2.5 sm:px-3">Findings</th>
            <th className="w-[7%] px-2 py-2.5 sm:px-3">High-risk</th>
            <th className="w-[9%] px-2 py-2.5 sm:px-3">When</th>
            <th className="w-[9%] px-2 py-2.5 sm:px-3">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s._id}
              className="border-t border-[var(--border)] transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
            >
              <td className="break-words px-2 py-2.5 capitalize sm:px-3">
                {s.type}
                {s.internalAudit ? (
                  <Badge tone="danger" className="ml-1.5 normal-case">
                    internal audit
                  </Badge>
                ) : (
                  <Badge tone="muted" className="ml-1.5 normal-case">
                    external
                  </Badge>
                )}
                {s.discoveryOnly ? (
                  <span
                    title="Discovered and saved candidate repos without analyzing them - use 'Analyze discovered repos' to run content analysis on them."
                  >
                    <Badge tone="accent" className="ml-1.5 normal-case">
                      discover only
                    </Badge>
                  </span>
                ) : null}
              </td>
              <td className="break-words px-2 py-2.5 sm:px-3">
                {s.scopeBrandId ? (
                  <div className="min-w-0">
                    <span className="font-medium">
                      {brandNameById.get(s.scopeBrandId) ?? 'Unknown company'}
                    </span>
                    {s.scopeKeyword ? (
                      s.scopeKeyword.length > KEYWORD_PREVIEW_LEN ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedKeyword({
                              company: brandNameById.get(s.scopeBrandId!) ?? 'Unknown company',
                              text: s.scopeKeyword!,
                            })
                          }
                          className="ml-1.5 inline-block max-w-[110px] truncate align-bottom rounded px-1.5 py-0.5 text-xs font-[family-name:var(--font-mono)] hover:underline"
                          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                          title="Click to view the full keyword"
                        >
                          {s.scopeKeyword}
                        </button>
                      ) : (
                        <span
                          className="ml-1.5 inline-block max-w-[110px] truncate align-bottom rounded px-1.5 py-0.5 text-xs font-[family-name:var(--font-mono)]"
                          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                          title={s.scopeKeyword}
                        >
                          {s.scopeKeyword}
                        </span>
                      )
                    ) : null}
                  </div>
                ) : s.scopeQuery ? (
                  <span
                    className="break-all font-[family-name:var(--font-mono)] text-xs text-[var(--muted)]"
                    title={s.scopeQuery}
                  >
                    {s.scopeQuery.length > 40 ? `${s.scopeQuery.slice(0, 40)}…` : s.scopeQuery}
                  </span>
                ) : (
                  <span className="text-[var(--muted)]">All companies</span>
                )}
              </td>
              <td className="break-words px-2 py-2.5 sm:px-3">
                {(s.mode || 'incremental').replaceAll('_', ' ')}
              </td>
              <td className="px-2 py-2.5 sm:px-3">
                <ScanStatusBadge status={s.status} />
              </td>
              <td className="break-words px-2 py-2.5 sm:px-3">
                {s.discoveryOnly ? (
                  <>
                    <span className="font-medium">{s.reposDiscovered ?? s.reposFound}</span>{' '}
                    discovered
                  </>
                ) : (
                  <>
                    {s.reposProcessed ?? s.reposAnalyzed}/{s.reposDiscovered ?? s.reposFound}{' '}
                    analyzed
                  </>
                )}
                {s.reposFailed ? ` (${s.reposFailed} failed)` : ''}
                {/* Anything above 1M is effectively "no cap" (the backend's
                    unbounded default is Number.MAX_SAFE_INTEGER) - showing
                    that raw number would just look like a bug. */}
                {s.maxRepos && s.maxRepos <= 1_000_000 ? (
                  <span className="text-[var(--muted)]"> (cap {s.maxRepos})</span>
                ) : null}
              </td>
              <td className="break-words px-2 py-2.5 text-[var(--muted)] sm:px-3">
                skip {s.reposSkipped ?? 0} · rescan {s.reposRescanned ?? 0}
                {(s.reposResumed ?? 0) > 0 ? ` · resume ${s.reposResumed}` : ''}
                {(s.reposPendingAnalysis ?? 0) > 0 ? ` · pending analysis ${s.reposPendingAnalysis}` : ''}
              </td>
              <td className="break-words px-2 py-2.5 sm:px-3">
                +{s.findingsNew ?? s.findingsCreated} / ~{s.findingsUnchanged ?? s.findingsUpdated}
              </td>
              <td
                className="break-words px-2 py-2.5 font-medium sm:px-3"
                style={(s.findingsHighRisk ?? 0) > 0 ? { color: 'var(--danger)' } : undefined}
              >
                {s.findingsHighRisk ?? 0}
              </td>
              <td className="break-words px-2 py-2.5 text-[var(--muted)] sm:px-3">
                {formatDateTime(s.startedAt)}
              </td>
              <td className="px-2 py-2.5 sm:px-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link href={`/scans/${s._id}`} className="text-[var(--accent)] hover:underline">
                    View
                  </Link>
                  {ACTIVE_STATUSES.includes(s.status) ? (
                    <button
                      type="button"
                      onClick={() => onCancel(s._id)}
                      disabled={cancellingId === s._id}
                      className="text-[var(--danger)] hover:underline disabled:opacity-60"
                    >
                      {cancellingId === s._id ? 'Cancelling…' : 'Cancel'}
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {expandedKeyword ? (
        <Modal
          title={`Keyword — ${expandedKeyword.company}`}
          onClose={() => setExpandedKeyword(null)}
        >
          <p className="whitespace-pre-wrap break-words text-sm">{expandedKeyword.text}</p>
        </Modal>
      ) : null}
    </div>
  );
}

export default function ScansPage() {
  const [data, setData] = useState<Paginated<ScanJob> | null>(null);
  // Independent of `data` (the general newest-20 history page, used only
  // for the "Scan history" table below) - see loadActive.
  const [activeData, setActiveData] = useState<Paginated<ScanJob> | null>(
    null,
  );
  const [refreshingActive, setRefreshingActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Separate from `error` (result of a deliberate action) - covers the
  // brands list and pending-analysis count fetched once on mount, so a
  // failure there shows up instead of looking identical to "you have no
  // brands yet" / "nothing pending".
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<ScanModeOption>('incremental');
  const [scanKind, setScanKind] = useState<ScanKind>(null);
  const [scope, setScope] = useState<ExternalScopeOption>('all');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandId, setBrandId] = useState('');
  const [customQuery, setCustomQuery] = useState('');
  const [searchKind, setSearchKind] = useState<'repositories' | 'code'>('repositories');
  const [pendingAnalysisCount, setPendingAnalysisCount] = useState<number | null>(
    null,
  );
  // Guards against an older, slower request (e.g. "all brands") resolving
  // AFTER a newer, narrower one (e.g. "just Angel One") and clobbering the
  // count back to the wrong scope - see loadPendingAnalysisCount.
  const pendingAnalysisRequestId = useRef(0);
  // Count for mode=reanalyze_existing - repos already analyzed, eligible to
  // be re-checked against a brand's CURRENT keyword list. Shares the same
  // brand/date scoping fields below as analyze_pending (analyzeBrandId/
  // analyzeFrom/analyzeTo/analyzeMaxRepos) since both are "replay analysis
  // over an existing repo backlog, no new search" modes - only which
  // backlog (pending vs already-analyzed) differs.
  const [analyzedCount, setAnalyzedCount] = useState<number | null>(null);
  const analyzedRequestId = useRef(0);
  // Count for mode=backfill_ai - existing findings never AI-assessed,
  // eligible for a manual backfill (see ScansService.countUnassessedFindings).
  // Shares the same analyzeBrandId/analyzeFrom/analyzeTo scoping as the two
  // counts above.
  const [unassessedCount, setUnassessedCount] = useState<number | null>(null);
  const unassessedRequestId = useRef(0);
  const [backfillMaxFindings, setBackfillMaxFindings] = useState('');
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMessage, setBackfillMessage] = useState('');
  // Optional scoping for mode=analyze_pending only - narrows which pending-
  // analysis backlog gets processed (and what the count/button reflect).
  // Separate state from the external-scan `brandId`/`from`/`to` above:
  // those mean "GitHub's own created/pushed dates" for a search-time scan,
  // these mean "which brand's backlog" and "when THIS WORKSPACE discovered
  // the repo" - see ManualScanDto.discoveredFrom/discoveredTo. All blank by
  // default = the existing workspace-wide bulk behavior.
  const [analyzeBrandId, setAnalyzeBrandId] = useState('');
  const [analyzeFrom, setAnalyzeFrom] = useState('');
  const [analyzeTo, setAnalyzeTo] = useState('');
  const [analyzeMaxRepos, setAnalyzeMaxRepos] = useState('');
  // Single date range applied to BOTH created and pushed activity (OR
  // semantics) - used by the plain "Start" button below and, for scope
  // 'brand', passed down to every keyword you turn on in KeywordScanner.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Sequential scheduler's staged, user-ordered queue - built via
  // KeywordScanner's "Schedule" column, shown/reordered/started at the top
  // of this page (KeywordScheduleQueue). Workspace-wide and persists across
  // switching which company is selected below - each entry carries its own
  // brandId, so the queue can mix keywords from several companies at once.
  const [queue, setQueue] = useState<KeywordRotationSlot[]>([]);

  async function load(options: { silent?: boolean } = {}) {
    // Background polls (see the auto-refresh effect below) must not flash
    // the loading spinner over the whole table every few seconds - only the
    // very first load, and a manual refresh, should show it.
    if (!options.silent) setLoading(true);
    try {
      const res = await api<Paginated<ScanJob>>('/scans?limit=20');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scans');
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  /**
   * Fetches active (queued/running) scans directly via the server-side
   * status filter, NOT by filtering `data`'s general newest-20 history page
   * client-side - that used to be how "Currently running" decided what to
   * show, which silently broke (the whole section vanishing even with a
   * scan genuinely still running) once enough OTHER scans had been created
   * since to push the active one off page 1. Both the sequential
   * scheduler's own keyword handoffs and each independently-watched
   * keyword's auto-restart keep creating new scan rows over time, so this
   * was a real, recurring failure mode, not a hypothetical one. Best-effort
   * on failure: keep showing the last known state rather than clearing an
   * actually-running scan off the screen just because one poll hiccuped.
   */
  async function loadActive(options: { manual?: boolean } = {}) {
    if (options.manual) setRefreshingActive(true);
    try {
      const res = await api<Paginated<ScanJob>>(
        '/scans?status=queued,running&limit=100',
      );
      setActiveData(res);
    } catch {
      // keep last known state
    } finally {
      if (options.manual) setRefreshingActive(false);
    }
  }

  // Same optional brand/discovered-date narrowing as the backend's
  // buildPendingAnalysisFilter, so the button/dropdown count always matches
  // exactly what an analyze_pending run with these filters would process.
  function loadPendingAnalysisCount(
    filters: { brandId?: string; discoveredFrom?: string; discoveredTo?: string } = {},
  ) {
    const requestId = ++pendingAnalysisRequestId.current;
    const params = new URLSearchParams();
    if (filters.brandId) params.set('brandId', filters.brandId);
    if (filters.discoveredFrom) params.set('discoveredFrom', filters.discoveredFrom);
    if (filters.discoveredTo) params.set('discoveredTo', filters.discoveredTo);
    const qs = params.toString();
    api<{ count: number }>(`/scans/pending-analysis-count${qs ? `?${qs}` : ''}`)
      .then((res) => {
        // A response for a request that's no longer the latest one in
        // flight is stale - e.g. picking a brand fires a new, narrower
        // request, but the previous "all brands" request can still resolve
        // after it if it happened to take longer, silently reverting the
        // count back to the wrong scope right after the user picked one.
        if (requestId === pendingAnalysisRequestId.current) {
          setPendingAnalysisCount(res.count);
        }
      })
      .catch(() => {
        if (requestId === pendingAnalysisRequestId.current) {
          setLoadError('Failed to load the pending-analysis count.');
        }
      });
  }

  // Mirrors loadPendingAnalysisCount above - same request-sequencing
  // guard, same optional brand/discovered-date narrowing, just against the
  // opposite backlog (buildAnalyzedFilter: already-analyzed repos).
  function loadAnalyzedCount(
    filters: { brandId?: string; discoveredFrom?: string; discoveredTo?: string } = {},
  ) {
    const requestId = ++analyzedRequestId.current;
    const params = new URLSearchParams();
    if (filters.brandId) params.set('brandId', filters.brandId);
    if (filters.discoveredFrom) params.set('discoveredFrom', filters.discoveredFrom);
    if (filters.discoveredTo) params.set('discoveredTo', filters.discoveredTo);
    const qs = params.toString();
    api<{ count: number }>(`/scans/analyzed-count${qs ? `?${qs}` : ''}`)
      .then((res) => {
        if (requestId === analyzedRequestId.current) {
          setAnalyzedCount(res.count);
        }
      })
      .catch(() => {
        if (requestId === analyzedRequestId.current) {
          setLoadError('Failed to load the already-analyzed count.');
        }
      });
  }

  // Mirrors loadPendingAnalysisCount above - same request-sequencing
  // guard, same optional brand/discovered-date narrowing, against the
  // never-AI-assessed findings backlog.
  function loadUnassessedCount(
    filters: { brandId?: string; discoveredFrom?: string; discoveredTo?: string } = {},
  ) {
    const requestId = ++unassessedRequestId.current;
    const params = new URLSearchParams();
    if (filters.brandId) params.set('brandId', filters.brandId);
    if (filters.discoveredFrom) params.set('discoveredFrom', filters.discoveredFrom);
    if (filters.discoveredTo) params.set('discoveredTo', filters.discoveredTo);
    const qs = params.toString();
    api<{ count: number }>(`/scans/unassessed-findings-count${qs ? `?${qs}` : ''}`)
      .then((res) => {
        if (requestId === unassessedRequestId.current) {
          setUnassessedCount(res.count);
        }
      })
      .catch(() => {
        if (requestId === unassessedRequestId.current) {
          setLoadError('Failed to load the unassessed-findings count.');
        }
      });
  }

  useEffect(() => {
    load();
    loadActive();
    api<Brand[]>('/brands')
      .then((res) => setBrands(res))
      .catch(() => setLoadError('Failed to load companies - brand pickers below may be empty.'));
  }, []);

  // Reloads both the pending-analysis and already-analyzed counts whenever
  // the shared scoping fields change - fires on mount too (all blank =
  // workspace-wide counts). Both are kept live regardless of which of the
  // two modes is currently selected, so switching the Scan mode dropdown
  // between them never shows a stale/zero count.
  useEffect(() => {
    const filters = {
      brandId: analyzeBrandId || undefined,
      discoveredFrom: analyzeFrom || undefined,
      discoveredTo: analyzeTo || undefined,
    };
    loadPendingAnalysisCount(filters);
    loadAnalyzedCount(filters);
    loadUnassessedCount(filters);
  }, [analyzeBrandId, analyzeFrom, analyzeTo]);

  // Always polls (not gated on "anything currently known to be running") -
  // the whole point of this section is to notice a scan that JUST started
  // (from the scheduler, another tab, a keyword auto-restart, ...) without
  // requiring a manual reload, so it can't only poll once something is
  // already known to be active. The query itself is cheap (indexed on
  // status), so polling it unconditionally while this page is open is fine.
  useEffect(() => {
    const id = setInterval(() => {
      loadActive();
      const filters = {
        brandId: analyzeBrandId || undefined,
        discoveredFrom: analyzeFrom || undefined,
        discoveredTo: analyzeTo || undefined,
      };
      loadPendingAnalysisCount(filters);
      loadAnalyzedCount(filters);
      loadUnassessedCount(filters);
    }, 5000);
    return () => clearInterval(id);
  }, [analyzeBrandId, analyzeFrom, analyzeTo]);

  const anyRunning = (activeData?.data.length ?? 0) > 0;

  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function cancelScanRow(id: string) {
    setCancellingId(id);
    setError('');
    try {
      await api(`/scans/${id}/cancel`, { method: 'POST' });
      // Re-sync from the server rather than optimistically patching -
      // cancel is "requested" and the scan finishes any in-flight work
      // before actually going terminal, so the real status (still
      // queued/running for a moment, then cancelled) is worth reflecting
      // accurately rather than guessing.
      await Promise.all([load({ silent: true }), loadActive()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel scan');
    } finally {
      setCancellingId(null);
    }
  }

  // What "Analyze discovered repos" would actually process - pendingAnalysisCount
  // capped by Max repos when one's set, so the dropdown/button never claims
  // a bigger number than what a click would really enqueue.
  const analyzeMaxReposNum = analyzeMaxRepos ? Number(analyzeMaxRepos) : undefined;
  const effectiveAnalyzeCount =
    pendingAnalysisCount !== null && analyzeMaxReposNum && analyzeMaxReposNum > 0
      ? Math.min(pendingAnalysisCount, analyzeMaxReposNum)
      : pendingAnalysisCount;
  // Same capping for "Re-analyze existing repos" - shares analyzeMaxRepos
  // with the analyze_pending fields above.
  const effectiveReanalyzeCount =
    analyzedCount !== null && analyzeMaxReposNum && analyzeMaxReposNum > 0
      ? Math.min(analyzedCount, analyzeMaxReposNum)
      : analyzedCount;
  // Same capping for "Backfill AI assessments" - its own max field, hard-
  // ceilinged at 500 server-side regardless of what's requested here.
  const backfillMaxNum = backfillMaxFindings ? Number(backfillMaxFindings) : undefined;
  const effectiveUnassessedCount =
    unassessedCount !== null && backfillMaxNum && backfillMaxNum > 0
      ? Math.min(unassessedCount, backfillMaxNum)
      : unassessedCount;

  const selectedBrand = brands.find((b) => b._id === brandId);
  const brandNameById = new Map(brands.map((b) => [b._id, b.name]));
  const selectedBrandHasTrustedOwners =
    (selectedBrand?.trustedGithubOwners.length ?? 0) > 0;
  const isInternalAudit = scanKind === 'internal';
  // Once a brand is chosen for an external, single-brand scan, discovery
  // happens entirely through the per-keyword toggle table below instead of
  // a generic "Start" button - see KeywordScanner.
  const showKeywordFlow =
    !isInternalAudit && scope === 'brand' && !!selectedBrand;
  // GitHub's code search has no created:/pushed: qualifier to attach a date
  // filter to at all - so the date range only ever applies to the other
  // scope/search-kind combinations.
  const dateRangeApplies = !(scope === 'query' && searchKind === 'code');

  function onBrandUpdate(updated: Brand) {
    setBrands((prev) => prev.map((b) => (b._id === updated._id ? updated : b)));
  }

  function resetScanKind() {
    setScanKind(null);
    setBrandId('');
    setScope('all');
    setCustomQuery('');
    setError('');
  }

  async function startManual() {
    if (mode !== 'analyze_pending' && mode !== 'reanalyze_existing') {
      if (isInternalAudit && !brandId) {
        setError('Pick a brand to run the internal audit against.');
        return;
      }
      if (isInternalAudit && brandId && !selectedBrandHasTrustedOwners) {
        setError(
          "This brand has no trustedGithubOwners configured - add its own GitHub org/user account(s) on the Brands page first.",
        );
        return;
      }
      if (!isInternalAudit && scope === 'brand' && !brandId) {
        setError('Pick a brand to scope this scan to.');
        return;
      }
      if (!isInternalAudit && scope === 'query' && !customQuery.trim()) {
        setError('Enter a GitHub search query to scope this scan to.');
        return;
      }
    }
    setRunning(true);
    setMessage('');
    setError('');
    try {
      const effectiveScope: ExternalScopeOption = isInternalAudit ? 'brand' : scope;
      const dateFilterApplies = dateRangeApplies;
      // analyze_pending and reanalyze_existing are both workspace-wide
      // replay modes with no scoping/filtering options of their own -
      // everything below only applies to a genuinely new discovery run.
      const isScopedMode = mode !== 'analyze_pending' && mode !== 'reanalyze_existing';
      const job = await api<ScanJob>('/scans/manual', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          ...(isScopedMode && effectiveScope === 'brand'
            ? { brandId, internalAudit: isInternalAudit }
            : {}),
          ...(isScopedMode && effectiveScope === 'query'
            ? { customQuery: customQuery.trim(), searchKind }
            : {}),
          // A single from/to pair, applied to both created and pushed -
          // matches KeywordScanner's own filter exactly, so results read
          // the same regardless of which flow found them.
          ...(isScopedMode && dateFilterApplies && from
            ? { createdFrom: from, pushedFrom: from }
            : {}),
          ...(isScopedMode && dateFilterApplies && to
            ? { createdTo: to, pushedTo: to }
            : {}),
          ...(isScopedMode && dateFilterApplies && (from || to)
            ? { dateFilterMode: 'or' }
            : {}),
          // Discover and save candidates without analyzing them yet - run
          // "Analyze discovered repos" (Scan mode dropdown) once you've
          // decided what's worth actually analyzing. Ignored by the backend
          // for internalAudit, which always runs full analysis (that's the
          // whole point of an audit).
          ...(isScopedMode && !isInternalAudit ? { discoveryOnly: true } : {}),
          // analyze_pending/reanalyze_existing's own optional scoping -
          // separate concepts from the brand/date fields above, which mean
          // "GitHub's own created/pushed dates" for a search-time scan;
          // here brandId means "which brand's backlog" and
          // discoveredFrom/To mean "when THIS WORKSPACE discovered the
          // repo" - see ManualScanDto.
          ...((mode === 'analyze_pending' || mode === 'reanalyze_existing') &&
          analyzeBrandId
            ? { brandId: analyzeBrandId }
            : {}),
          ...((mode === 'analyze_pending' || mode === 'reanalyze_existing') &&
          analyzeFrom
            ? { discoveredFrom: analyzeFrom }
            : {}),
          ...((mode === 'analyze_pending' || mode === 'reanalyze_existing') &&
          analyzeTo
            ? { discoveredTo: analyzeTo }
            : {}),
          ...((mode === 'analyze_pending' || mode === 'reanalyze_existing') &&
          analyzeMaxRepos
            ? { maxRepos: Number(analyzeMaxRepos) }
            : {}),
        }),
      });
      setMessage(`Scan accepted (${job.status}, mode=${job.mode || mode}). Opening live progress…`);
      window.location.href = `/scans/${job._id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
      setRunning(false);
    }
  }

  // Not a scan job (no GitHub calls, no repo discovery) - just queues AI
  // intent-assessment jobs directly for existing findings, so it never
  // redirects to a scan progress page like startManual does.
  async function runBackfill() {
    setBackfilling(true);
    setBackfillMessage('');
    setError('');
    try {
      const res = await api<{ queued: number }>('/scans/backfill-intent-assessments', {
        method: 'POST',
        body: JSON.stringify({
          brandId: analyzeBrandId || undefined,
          discoveredFrom: analyzeFrom || undefined,
          discoveredTo: analyzeTo || undefined,
          maxFindings: backfillMaxFindings ? Number(backfillMaxFindings) : undefined,
        }),
      });
      setBackfillMessage(
        res.queued === 0
          ? 'Nothing to backfill - no unassessed findings match this scope.'
          : `Queued ${res.queued} finding${res.queued === 1 ? '' : 's'} for AI assessment. They’ll show up on their Finding detail pages as each one completes.`,
      );
      loadUnassessedCount({
        brandId: analyzeBrandId || undefined,
        discoveredFrom: analyzeFrom || undefined,
        discoveredTo: analyzeTo || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backfill failed');
    } finally {
      setBackfilling(false);
    }
  }

  return (
    <RequireAuth>
      <AppShell title="Scans">
        <KeywordScheduleQueue
          brands={brands}
          queue={queue}
          onQueueChange={setQueue}
          onRefreshScans={() => loadActive({ manual: true })}
        />

        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-[var(--muted)]">Currently running</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => loadActive({ manual: true })}
              loading={refreshingActive}
            >
              Refresh
            </Button>
          </div>
          {anyRunning ? (
            <ScanTable
              rows={activeData?.data ?? []}
              brandNameById={brandNameById}
              cancellingId={cancellingId}
              onCancel={cancelScanRow}
            />
          ) : (
            <p className="text-sm text-[var(--muted)]">No scans currently running</p>
          )}
        </div>

        <Card id="start-manual-scan" className="mb-6 space-y-3 p-3 scroll-mt-4">
          <h3 className="text-sm font-semibold text-[var(--muted)]">Start a manual scan</h3>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Scan mode">
              <Select value={mode} onChange={(e) => setMode(e.target.value as ScanModeOption)}>
                <option value="incremental">Discover repositories</option>
                <option value="analyze_pending">
                  Analyze discovered repos{effectiveAnalyzeCount ? ` (${effectiveAnalyzeCount})` : ''}
                </option>
                <option value="reanalyze_existing">
                  Re-analyze existing repos
                  {effectiveReanalyzeCount ? ` (${effectiveReanalyzeCount})` : ''}
                </option>
                <option value="backfill_ai">
                  Backfill AI assessments
                  {effectiveUnassessedCount ? ` (${effectiveUnassessedCount})` : ''}
                </option>
              </Select>
            </Field>
          </div>

          {mode === 'analyze_pending' ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--muted)]">
                Runs real content analysis (clone/fetch, detection rules, findings) on repos a
                previous &quot;Discover only&quot; scan found and saved but didn&apos;t analyze
                yet. Workspace-wide and unlimited by default — narrow to one brand, a discovered-
                date window, and/or a max count below, or leave everything blank for a full bulk
                run.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Brand">
                  <Select value={analyzeBrandId} onChange={(e) => setAnalyzeBrandId(e.target.value)}>
                    <option value="">All brands</option>
                    {brands.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Discovered from">
                  <Input
                    type="date"
                    value={analyzeFrom}
                    onChange={(e) => setAnalyzeFrom(e.target.value)}
                  />
                </Field>
                <Field label="Discovered to">
                  <Input
                    type="date"
                    value={analyzeTo}
                    onChange={(e) => setAnalyzeTo(e.target.value)}
                  />
                </Field>
                <Field label="Max repos">
                  <Input
                    type="number"
                    min={1}
                    value={analyzeMaxRepos}
                    onChange={(e) => setAnalyzeMaxRepos(e.target.value)}
                    placeholder="No limit"
                    className="w-28"
                  />
                </Field>
              </div>
              <Button
                type="button"
                onClick={startManual}
                disabled={pendingAnalysisCount === 0}
                loading={running}
              >
                {running
                  ? 'Enqueueing…'
                  : pendingAnalysisCount === 0
                    ? 'Nothing pending analysis'
                    : `Analyze ${effectiveAnalyzeCount ?? ''} discovered repositories`}
              </Button>
              <p className="text-sm">
                <Link href="/repositories" className="text-[var(--accent)] hover:underline">
                  Browse discovered repositories →
                </Link>
              </p>
            </div>
          ) : mode === 'reanalyze_existing' ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--muted)]">
                Re-runs real content analysis on repos that were ALREADY analyzed - for when a
                brand&apos;s own keywords (Companies page) changed since those repos were last
                checked. Always a full re-scan, regardless of whether the repo&apos;s code has
                changed. Workspace-wide and unlimited by default — narrow to one brand, a
                discovered-date window, and/or a max count below, or leave everything blank for a
                full bulk run.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Brand">
                  <Select value={analyzeBrandId} onChange={(e) => setAnalyzeBrandId(e.target.value)}>
                    <option value="">All brands</option>
                    {brands.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Discovered from">
                  <Input
                    type="date"
                    value={analyzeFrom}
                    onChange={(e) => setAnalyzeFrom(e.target.value)}
                  />
                </Field>
                <Field label="Discovered to">
                  <Input
                    type="date"
                    value={analyzeTo}
                    onChange={(e) => setAnalyzeTo(e.target.value)}
                  />
                </Field>
                <Field label="Max repos">
                  <Input
                    type="number"
                    min={1}
                    value={analyzeMaxRepos}
                    onChange={(e) => setAnalyzeMaxRepos(e.target.value)}
                    placeholder="No limit"
                    className="w-28"
                  />
                </Field>
              </div>
              <Button
                type="button"
                onClick={startManual}
                disabled={analyzedCount === 0}
                loading={running}
              >
                {running
                  ? 'Enqueueing…'
                  : analyzedCount === 0
                    ? 'Nothing analyzed yet to re-check'
                    : `Re-analyze ${effectiveReanalyzeCount ?? ''} existing repositories`}
              </Button>
              <p className="text-sm">
                <Link href="/repositories" className="text-[var(--accent)] hover:underline">
                  Browse discovered repositories →
                </Link>
              </p>
            </div>
          ) : mode === 'backfill_ai' ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--muted)]">
                Queues an AI intent/risk assessment for existing findings that have never been
                assessed - the only way to get an AI score onto findings that predate this
                feature, since a plain rescan of an already-analyzed repo just reproduces the
                same finding and never triggers one. Narrow to one brand, a discovered-date
                window, and/or a max count below (hard-capped at 500 per run either way) to
                control how much of your GEMINI_API_KEY / OPENROUTER_API_KEY quota one click
                uses.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Brand">
                  <Select value={analyzeBrandId} onChange={(e) => setAnalyzeBrandId(e.target.value)}>
                    <option value="">All brands</option>
                    {brands.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Discovered from">
                  <Input
                    type="date"
                    value={analyzeFrom}
                    onChange={(e) => setAnalyzeFrom(e.target.value)}
                  />
                </Field>
                <Field label="Discovered to">
                  <Input
                    type="date"
                    value={analyzeTo}
                    onChange={(e) => setAnalyzeTo(e.target.value)}
                  />
                </Field>
                <Field label="Max findings">
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={backfillMaxFindings}
                    onChange={(e) => setBackfillMaxFindings(e.target.value)}
                    placeholder="Up to 500"
                    className="w-28"
                  />
                </Field>
              </div>
              <Button
                type="button"
                onClick={runBackfill}
                disabled={unassessedCount === 0}
                loading={backfilling}
              >
                {backfilling
                  ? 'Queueing…'
                  : unassessedCount === 0
                    ? 'Nothing to backfill'
                    : `Backfill ${effectiveUnassessedCount ?? ''} findings`}
              </Button>
              {backfillMessage ? (
                <p className="text-sm text-[var(--accent)]">{backfillMessage}</p>
              ) : null}
            </div>
          ) : scanKind === null ? (
            <div>
              <p className="mb-2 text-sm text-[var(--muted)]">What do you want to run?</p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setScanKind('internal')}
                  className="flex min-w-[260px] flex-1 flex-col items-start gap-2 rounded-xl border-2 border-[var(--danger)]/30 bg-[var(--danger)]/[0.07] p-4 text-left transition-colors duration-150 hover:border-[var(--danger)]/60 hover:bg-[var(--danger)]/[0.12]"
                >
                  <span
                    className="inline-flex items-center gap-2 text-base font-semibold"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Lock className="h-4 w-4" aria-hidden />
                    Run Internal Audit
                  </span>
                  <span className="text-xs text-[var(--muted)]">
                    Scan a client&apos;s own repos for exposed credentials and risks.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setScanKind('external')}
                  className="flex min-w-[260px] flex-1 flex-col items-start gap-2 rounded-xl border-2 border-[var(--accent-border)]/60 bg-[var(--accent-soft)] p-4 text-left transition-colors duration-150 hover:border-[var(--accent)]/60 hover:bg-[var(--accent-border)]/20"
                >
                  <span
                    className="inline-flex items-center gap-2 text-base font-semibold"
                    style={{ color: 'var(--accent)' }}
                  >
                    <Globe className="h-4 w-4" aria-hidden />
                    Run External Scan
                  </span>
                  <span className="text-xs text-[var(--muted)]">
                    Search GitHub for repos impersonating a client.
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <div
              className="space-y-2.5 rounded-lg border p-3"
              style={{
                borderColor: isInternalAudit ? 'var(--danger)' : 'var(--accent-border)',
                background: isInternalAudit ? 'var(--danger-soft)' : 'var(--accent-soft)',
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="inline-flex items-center gap-2 text-sm font-semibold"
                  style={{ color: isInternalAudit ? 'var(--danger)' : 'var(--accent)' }}
                >
                  {isInternalAudit ? <Lock className="h-4 w-4" aria-hidden /> : <Globe className="h-4 w-4" aria-hidden />}
                  {isInternalAudit ? 'Internal Audit' : 'External Scan'}
                </span>
                <button
                  type="button"
                  onClick={resetScanKind}
                  className="rounded px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent-border)]/20 hover:underline"
                >
                  ← Back
                </button>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {isInternalAudit ? (
                  <Field label="Brand to audit">
                    <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                      <option value="">Select a brand…</option>
                      {brands.map((b) => (
                        <option key={b._id} value={b._id}>
                          {b.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <Field label="Scope">
                    <Select
                      value={scope}
                      onChange={(e) => setScope(e.target.value as ExternalScopeOption)}
                    >
                      <option value="all">All enabled brands</option>
                      <option value="brand">One brand</option>
                      <option value="query">Custom GitHub query</option>
                    </Select>
                  </Field>
                )}
                {!isInternalAudit && scope === 'brand' ? (
                  <Field label="Brand">
                    <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                      <option value="">Select a brand…</option>
                      {brands.map((b) => (
                        <option key={b._id} value={b._id}>
                          {b.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {!isInternalAudit && scope === 'query' ? (
                  <>
                    <Field label="GitHub query" className="min-w-[240px] flex-1">
                      <Input
                        value={customQuery}
                        onChange={(e) => setCustomQuery(e.target.value)}
                        placeholder='e.g. phonepe apk in:name'
                      />
                    </Field>
                    <Field label="Search kind">
                      <Select
                        value={searchKind}
                        onChange={(e) => setSearchKind(e.target.value as 'repositories' | 'code')}
                      >
                        <option value="repositories">Repositories</option>
                        <option value="code">Code</option>
                      </Select>
                    </Field>
                  </>
                ) : null}
              </div>

              {dateRangeApplies && !showKeywordFlow ? (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="From">
                    <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </Field>
                  <Field label="To">
                    <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                  </Field>
                  <p className="pb-2.5 text-xs text-[var(--muted)]">
                    Matches repos created OR pushed within this range (leave blank for no date
                    filter).
                  </p>
                </div>
              ) : null}

              {isInternalAudit && brandId && !selectedBrandHasTrustedOwners ? (
                <Alert tone="danger">
                  {selectedBrand?.name} has no trustedGithubOwners configured — add its own
                  GitHub org/user account(s) on the{' '}
                  <Link href="/brands" className="underline">
                    Brands
                  </Link>{' '}
                  page first.
                </Alert>
              ) : null}

              {showKeywordFlow && selectedBrand ? (
                <KeywordScanner
                  brand={selectedBrand}
                  from={from}
                  to={to}
                  onBrandUpdate={onBrandUpdate}
                  onQueue={(keyword, durationMs) =>
                    setQueue((prev) => [
                      ...prev,
                      { brandId: selectedBrand._id, keyword, durationMs },
                    ])
                  }
                />
              ) : (
                <>
                  <Button
                    type="button"
                    onClick={startManual}
                    loading={running}
                    variant={isInternalAudit ? 'danger' : 'primary'}
                  >
                    {running
                      ? 'Enqueueing…'
                      : isInternalAudit
                        ? 'Start internal audit'
                        : 'Start external scan'}
                  </Button>
                  <p className="text-sm text-[var(--muted)]">
                    {isInternalAudit
                      ? "Internal audit skips brand-mention search entirely and instead enumerates every repo under the brand's own trustedGithubOwners accounts, running the full detection ruleset (secrets, malware, phishing, impersonation, and more) against each one — for finding leaked credentials or other risks in your own repos before someone else does, not for catching impersonators."
                      : "External scan discovers repos that mention, impersonate, or reuse a client's name/content/credentials and saves them as candidates. Requires Redis. Without "}
                    {isInternalAudit ? null : (
                      <code className="text-[var(--accent)]">GITHUB_TOKEN</code>
                    )}
                    {isInternalAudit
                      ? null
                      : ', workers complete scans without live GitHub calls. Run "Analyze discovered repos" afterwards to run the full detection pipeline on what was found.'}
                  </p>
                </>
              )}
            </div>
          )}
        </Card>
        {message ? <Alert tone="success" className="mb-4">{message}</Alert> : null}
        {error ? <ErrorState message={error} /> : null}
        {loadError ? <Alert tone="warning" className="mb-4">{loadError}</Alert> : null}
        {loading ? <TableSkeleton rows={4} cols={6} /> : null}
        {!loading && data && data.data.length === 0 ? (
          <EmptyState title="No scans yet" body="Start a manual scan to create the first job." />
        ) : null}
        {data && data.data.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[var(--muted)]">Scan history</h3>
            <ScanTable
              rows={data.data}
              brandNameById={brandNameById}
              cancellingId={cancellingId}
              onCancel={cancelScanRow}
            />
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
