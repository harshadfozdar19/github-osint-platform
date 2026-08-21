'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Pagination,
  Select,
  SeverityBadge,
  TableSkeleton,
} from '@/components/ui';
import { api, Finding, Paginated, Repository, RulePrecisionStat } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/date';
import { openExternalLink } from '@/lib/external-link';

function statusLabel(status?: string) {
  switch (status) {
    case 'acknowledged':
      return 'Acknowledged';
    case 'resolved':
      return 'Resolved';
    case 'false_positive':
      return 'False positive';
    default:
      return 'Open';
  }
}

const LIST_STATUS_OPTIONS: Array<{
  value: 'none' | 'watchlist' | 'ignorelist' | 'allowlist' | 'blocklist';
  label: string;
}> = [
  { value: 'none', label: 'Unclassified' },
  { value: 'watchlist', label: 'Watchlist' },
  { value: 'ignorelist', label: 'Ignorelist' },
  { value: 'allowlist', label: 'Allowlist' },
  { value: 'blocklist', label: 'Blocklist' },
];

/** Color coding for the analyst classification tag, also used to tint the whole row so a classified finding is recognizable at a glance. */
const LIST_STATUS_STYLE: Record<
  string,
  { color: string; bg: string; border: string; rowBg: string }
> = {
  watchlist: {
    color: 'var(--warning)',
    bg: 'var(--warning-soft)',
    border: 'var(--warning-border-soft)',
    rowBg: 'var(--warning-soft)',
  },
  ignorelist: {
    color: 'var(--muted)',
    bg: 'var(--bg-subtle)',
    border: 'var(--border)',
    rowBg: 'var(--bg-subtle)',
  },
  allowlist: {
    color: 'var(--low)',
    bg: 'var(--low-soft)',
    border: 'var(--low-border-soft)',
    rowBg: 'var(--low-soft)',
  },
  blocklist: {
    color: 'var(--danger)',
    bg: 'var(--danger-soft)',
    border: 'var(--danger-border-soft)',
    rowBg: 'var(--danger-soft)',
  },
};

/** Categories beyond this length get truncated with a click-to-expand modal, instead of wrapping the whole row taller. */
const CATEGORY_PREVIEW_LEN = 30;

function threatClassLabel(tc: string) {
  switch (tc) {
    case 'credential_exposure':
      return 'Credential exposure';
    case 'malicious_intent':
      return 'Malicious intent';
    default:
      return 'Other';
  }
}

function ThreatClassBadge({ threatClass }: { threatClass: string[] }) {
  if (threatClass.length === 0) return <span className="text-[var(--muted)]">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {threatClass.map((tc) => (
        <Badge key={tc} tone={tc === 'malicious_intent' ? 'warning' : 'accent'}>
          {threatClassLabel(tc)}
        </Badge>
      ))}
    </div>
  );
}

function OriginBadge({ origin }: { origin?: 'internal' | 'external' }) {
  const isInternal = origin === 'internal';
  return (
    <Badge
      tone={isInternal ? 'danger' : 'muted'}
      className="normal-case"
    >
      <span
        title={
          isInternal
            ? "Found in the brand's own repo (internal audit) - rotate this credential now."
            : "Found in someone else's repo - consider reporting/requesting takedown."
        }
      >
        {isInternal ? 'Internal — rotate' : 'External'}
      </span>
    </Badge>
  );
}

function RulePrecisionPanel() {
  const [stats, setStats] = useState<RulePrecisionStat[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || stats) return;
    setLoading(true);
    setError('');
    api<RulePrecisionStat[]>('/findings/rule-precision')
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [open, stats]);

  return (
    <Card className="mb-6 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
      >
        <span>Rule precision in this workspace</span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-[var(--muted)]" aria-hidden />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--muted)]" aria-hidden />
        )}
      </button>
      {open ? (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <p className="mb-3 text-xs text-[var(--muted)]">
            False-positive rate per detection rule, computed from this workspace&apos;s own triage
            history.
          </p>
          {loading ? <TableSkeleton rows={3} cols={4} /> : null}
          {error ? <ErrorState message={error} /> : null}
          {stats && stats.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              No triaged findings yet — precision stats build up as findings are marked resolved
              or false positive.
            </p>
          ) : null}
          {stats && stats.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table className="min-w-full text-sm">
                <thead className="bg-[var(--bg-subtle)] text-left text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Rule</th>
                    <th className="px-3 py-2 font-medium">Findings</th>
                    <th className="px-3 py-2 font-medium">False positives</th>
                    <th className="px-3 py-2 font-medium">FP rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr
                      key={s.ruleId}
                      className="border-t border-[var(--border)] transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
                    >
                      <td className="px-3 py-2">{s.ruleName}</td>
                      <td className="px-3 py-2 font-[family-name:var(--font-mono)]">
                        {s.totalFindings}
                      </td>
                      <td className="px-3 py-2 font-[family-name:var(--font-mono)]">
                        {s.falsePositiveCount}
                      </td>
                      <td
                        className="px-3 py-2 font-[family-name:var(--font-mono)]"
                        style={{
                          color: s.falsePositiveRate >= 0.3 ? 'var(--high)' : 'var(--text)',
                        }}
                      >
                        {(s.falsePositiveRate * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// Findings are discovered in the past, so presets only look backward from now.
function dateRangeBounds(preset: string): { from?: string; to?: string } {
  const now = new Date();
  switch (preset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    case '7d': {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    case '30d': {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    default:
      return {};
  }
}

export default function FindingsPage() {
  const [data, setData] = useState<Paginated<Finding> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [threatClass, setThreatClass] = useState('');
  const [origin, setOrigin] = useState('');
  const [status, setStatus] = useState('');
  const [listStatusFilter, setListStatusFilter] = useState('');
  const [updatingListStatus, setUpdatingListStatus] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<{
    repo: string;
    categories: string[];
  } | null>(null);
  const [brand, setBrand] = useState('');
  const [dateRange, setDateRange] = useState('');
  // Filters by the repo's own GitHub created/pushed timestamps, not by when
  // we recorded the finding (that's `dateRange` above) - this is what "show
  // me only repos active today" actually means, since a finding can be
  // old even for a repo that just got a new commit.
  const [repoActivity, setRepoActivity] = useState('');
  // '' = no filter, 'true' = only repos with a live deployment, 'false' = "Not defined" only.
  const [deployment, setDeployment] = useState('');
  const [sortBy, setSortBy] = useState<'createdAt' | 'riskScore' | 'keywordMatchCount'>(
    'createdAt',
  );
  const [page, setPage] = useState(1);

  async function load(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: '10',
        sortBy,
        sortOrder: 'desc',
      });
      if (search) params.set('search', search);
      if (severity) params.set('severity', severity);
      if (category) params.set('category', category);
      if (threatClass) params.set('threatClass', threatClass);
      if (origin) params.set('origin', origin);
      if (status) params.set('status', status);
      if (listStatusFilter) params.set('listStatus', listStatusFilter);
      if (brand) params.set('brand', brand);
      const { from, to } = dateRangeBounds(dateRange);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const { from: repoFrom, to: repoTo } = dateRangeBounds(repoActivity);
      if (repoFrom) params.set('repoActiveFrom', repoFrom);
      if (repoTo) params.set('repoActiveTo', repoTo);
      if (deployment) params.set('hasDeployment', deployment);
      const res = await api<Paginated<Finding>>(`/findings?${params}`);
      setData(res);
      setPage(nextPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load findings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onFilter(e: FormEvent) {
    e.preventDefault();
    load(1);
  }

  async function updateListStatus(findingId: string, value: string) {
    setUpdatingListStatus(findingId);
    try {
      await api(`/findings/${findingId}/list-status`, {
        method: 'PATCH',
        body: JSON.stringify({ listStatus: value }),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              data: prev.data.map((f) =>
                f._id === findingId
                  ? { ...f, listStatus: value as Finding['listStatus'] }
                  : f,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update list status');
    } finally {
      setUpdatingListStatus(null);
    }
  }

  return (
    <RequireAuth>
      <AppShell title="Findings" subtitle="Search, filter, and triage detected threats.">
        <Card className="mb-6 p-4">
          <form onSubmit={onFilter} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Search">
              <Input
                placeholder="Search summary or brand"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
            <Field label="Severity">
              <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="">All severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="resolved">Resolved</option>
                <option value="false_positive">False positive</option>
              </Select>
            </Field>
            <Field label="List">
              <Select
                value={listStatusFilter}
                onChange={(e) => setListStatusFilter(e.target.value)}
                title="Analyst classification tag - independent of Status above"
              >
                <option value="">All</option>
                {LIST_STATUS_OPTIONS.filter((o) => o.value !== 'none').map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                <option value="none">Unclassified only</option>
              </Select>
            </Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                <option value="exposed_secret">Exposed secret</option>
                <option value="brand_impersonation">Brand impersonation</option>
                <option value="phishing">Phishing</option>
                <option value="fake_apk">Fake APK</option>
                <option value="malware">Malware</option>
                <option value="suspicious_repo">Suspicious repo</option>
              </Select>
            </Field>
            <Field label="Threat class">
              <Select value={threatClass} onChange={(e) => setThreatClass(e.target.value)}>
                <option value="">All threat classes</option>
                <option value="credential_exposure">Credential exposure</option>
                <option value="malicious_intent">Malicious intent</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Origin">
              <Select
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                title="internal = found in the brand's own repo (rotate it); external = found in someone else's repo (report/takedown)"
              >
                <option value="">Internal + external</option>
                <option value="internal">Internal (our own repos)</option>
                <option value="external">External (impersonators)</option>
              </Select>
            </Field>
            <Field label="Brand">
              <Input
                placeholder="Brand filter"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
              />
            </Field>
            <Field label="Discovered">
              <Select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
                title="When WE first recorded this finding - not when the repo itself was last active on GitHub."
              >
                <option value="">All time</option>
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </Select>
            </Field>
            <Field label="Repo activity">
              <Select
                value={repoActivity}
                onChange={(e) => setRepoActivity(e.target.value)}
                title="Only findings whose repository was created OR pushed to (new commits) on GitHub within this window - independent of when the finding was discovered. This is what actually tells you a repo is still active, not stale."
              >
                <option value="">All time</option>
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </Select>
            </Field>
            <Field label="Deployment">
              <Select
                value={deployment}
                onChange={(e) => setDeployment(e.target.value)}
                title="Whether a live deployment URL was found on the repo during analysis (GitHub Pages, Vercel, etc.)"
              >
                <option value="">All</option>
                <option value="true">Live link found</option>
                <option value="false">Not defined</option>
              </Select>
            </Field>
            <Field label="Sort by">
              <Select
                value={sortBy}
                onChange={(e) =>
                  setSortBy(e.target.value as 'createdAt' | 'riskScore' | 'keywordMatchCount')
                }
              >
                <option value="createdAt">Newest first</option>
                <option value="riskScore">Highest risk first</option>
                <option value="keywordMatchCount">Most keywords matched first</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" className="w-full">
                Apply filters
              </Button>
            </div>
          </form>
        </Card>

        <RulePrecisionPanel />

        {/* Only the FIRST load (nothing fetched yet) shows the skeleton in
            place of a table - a refetch (Apply filters, search, sort) keeps
            showing the previous results (dimmed) instead of stacking the
            skeleton on top of them, which is what made the page look
            broken/distorted while typing a search or applying a filter. */}
        {loading && !data ? <TableSkeleton rows={6} cols={7} /> : null}
        {error ? <ErrorState message={error} onRetry={() => load()} /> : null}

        {!loading && data && data.data.length === 0 ? (
          <EmptyState
            title="No findings match"
            body="Try clearing filters, seeding demo data, or running a manual scan."
          />
        ) : null}

        {data && data.data.length > 0 ? (
          <div
            className={clsx(
              'overflow-x-auto rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)] transition-opacity duration-150',
              loading ? 'opacity-50' : 'opacity-100',
            )}
          >
            <table className="min-w-[1250px] w-full text-sm">
              <thead className="bg-[var(--bg-subtle)] text-left text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Repository</th>
                  <th
                    className="px-4 py-3 font-medium"
                    title="Analyst classification tag - independent of Status"
                  >
                    List
                  </th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Deployment</th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Brand</th>
                  <th className="px-4 py-3 font-medium">Origin</th>
                  <th className="px-4 py-3 font-medium">Severity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Score</th>
                  <th className="px-4 py-3 font-medium" title="Distinct curated keywords matched">
                    Keywords
                  </th>
                  <th className="px-4 py-3 font-medium">Categories</th>
                  <th className="px-4 py-3 font-medium">Threat class</th>
                  <th className="px-4 py-3 font-medium">Discovered</th>
                  <th
                    className="px-4 py-3 font-medium"
                    title="When GitHub says this repo was last pushed to (commits, branch updates) - not when we found it."
                  >
                    Repo pushed
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((f) => {
                  const repo = f.repositoryId as Repository | undefined;
                  const listMeta =
                    f.listStatus && f.listStatus !== 'none'
                      ? LIST_STATUS_STYLE[f.listStatus]
                      : null;
                  return (
                    <tr
                      key={f._id}
                      className={clsx(
                        'border-t border-[var(--border)] transition-colors duration-150',
                        listMeta ? 'hover:brightness-95' : 'hover:bg-[var(--bg-subtle)]',
                      )}
                      style={listMeta ? { background: listMeta.rowBg } : undefined}
                    >
                      <td className="px-4 py-3">
                        <Link href={`/findings/${f._id}`} className="font-medium hover:text-[var(--accent)]">
                          {repo?.fullName || f.summary}
                        </Link>
                        {f.isDemo ? (
                          <span className="ml-2 text-xs text-[var(--warning)]">DEMO</span>
                        ) : null}
                        {f.lastChangeType === 'reopened' ? (
                          <span className="ml-2 rounded px-1.5 py-0.5 text-xs text-[var(--high)] border border-[var(--high)]/40">
                            REOPENED
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Select
                          value={f.listStatus || 'none'}
                          onChange={(e) => updateListStatus(f._id, e.target.value)}
                          disabled={updatingListStatus === f._id}
                          className="!py-1 text-xs font-medium"
                          style={
                            f.listStatus && f.listStatus !== 'none'
                              ? {
                                  color: LIST_STATUS_STYLE[f.listStatus].color,
                                  background: LIST_STATUS_STYLE[f.listStatus].bg,
                                  borderColor: LIST_STATUS_STYLE[f.listStatus].border,
                                }
                              : undefined
                          }
                        >
                          {LIST_STATUS_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-4 py-3">
                        {repo?.deployment ? (
                          <button
                            type="button"
                            onClick={() => openExternalLink(repo.deployment!.url)}
                            className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                            title={repo.deployment.url}
                          >
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                            <span className="max-w-[160px] truncate">
                              {repo.deployment.url.replace(/^https?:\/\//, '')}
                            </span>
                          </button>
                        ) : (
                          <span className="text-[var(--muted)]">Not defined</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{f.brandName || '—'}</td>
                      <td className="px-4 py-3">
                        <OriginBadge origin={f.origin} />
                      </td>
                      <td className="px-4 py-3">
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                        {statusLabel(f.status)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-[family-name:var(--font-mono)]">
                        {f.riskScore}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-[family-name:var(--font-mono)]">
                        {f.keywordMatchCount ?? 0}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {(() => {
                          const categoryLabels = (f.categories ?? []).map((c) =>
                            c.replace(/_/g, ' '),
                          );
                          const joined = categoryLabels.join(', ');
                          if (joined.length <= CATEGORY_PREVIEW_LEN) return joined;
                          return (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedCategories({
                                  repo: repo?.fullName || f.summary,
                                  categories: categoryLabels,
                                })
                              }
                              className="text-left hover:text-[var(--accent)] hover:underline"
                              title="Click to view all categories"
                            >
                              {joined.slice(0, CATEGORY_PREVIEW_LEN)}…
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <ThreatClassBadge threatClass={f.threatClass || []} />
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)] whitespace-nowrap">
                        {formatDateTime(f.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)] whitespace-nowrap">
                        {formatDate(repo?.githubPushedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {data && data.meta.totalPages > 1 ? (
          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={load} />
        ) : null}

        {expandedCategories ? (
          <Modal
            title={`Categories — ${expandedCategories.repo}`}
            onClose={() => setExpandedCategories(null)}
          >
            <div className="flex flex-wrap gap-1.5">
              {expandedCategories.categories.map((c) => (
                <Badge key={c} tone="muted" className="capitalize">
                  {c}
                </Badge>
              ))}
            </div>
          </Modal>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
