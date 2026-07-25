'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { LoadingBlock, SeverityBadge } from '@/components/ui';
import { api, Finding, Repository } from '@/lib/api';

type FindingStatus = 'open' | 'acknowledged' | 'resolved' | 'false_positive';

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

export default function FindingDetailPage() {
  const params = useParams<{ id: string }>();
  const [finding, setFinding] = useState<Finding | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<FindingStatus>('open');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [triageMessage, setTriageMessage] = useState('');

  useEffect(() => {
    if (!params.id) return;
    api<Finding>(`/findings/${params.id}`)
      .then((f) => {
        setFinding(f);
        setStatus((f.status as FindingStatus) || 'open');
        setNote(f.triageNote || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [params.id]);

  async function onTriage(e: FormEvent) {
    e.preventDefault();
    if (!params.id) return;
    setSaving(true);
    setTriageMessage('');
    setError('');
    try {
      const updated = await api<Finding>(`/findings/${params.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note }),
      });
      setFinding(updated);
      setStatus((updated.status as FindingStatus) || status);
      setNote(updated.triageNote || '');
      setTriageMessage('Triage saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setSaving(false);
    }
  }

  const repo = finding?.repositoryId as Repository | undefined;

  return (
    <RequireAuth>
      <AppShell title="Finding detail" subtitle="Repository context, triage, and score explanation.">
        <p className="mb-4">
          <Link href="/findings" className="text-sm text-[var(--accent)] hover:underline">
            ← Back to findings
          </Link>
        </p>
        {loading ? <LoadingBlock /> : null}
        {error ? <p className="text-[var(--danger)]">{error}</p> : null}
        {finding ? (
          <div className="space-y-6">
            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <SeverityBadge severity={finding.severity} />
                <span className="font-[family-name:var(--font-mono)] text-2xl">
                  {finding.riskScore}
                </span>
                <span className="text-xs border border-[var(--border)] px-2 py-0.5 rounded text-[var(--muted)]">
                  {statusLabel(finding.status)}
                </span>
                {finding.lastChangeType === 'reopened' ? (
                  <span className="text-xs text-[var(--high)] border border-[var(--high)]/40 px-2 py-0.5 rounded">
                    REOPENED
                    {finding.reopenedAt
                      ? ` · ${new Date(finding.reopenedAt).toLocaleString()}`
                      : ''}
                  </span>
                ) : null}
                {finding.isDemo ? (
                  <span className="text-xs text-[var(--warning)] border border-[var(--warning)]/40 px-2 py-0.5 rounded">
                    DEMO
                  </span>
                ) : null}
              </div>
              <h2 className="mt-3 text-xl font-medium">{finding.summary}</h2>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Brand: {finding.brandName || '—'} · Categories:{' '}
                {finding.categories?.map((c) => c.replace(/_/g, ' ')).join(', ')}
              </p>
            </section>

            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5">
              <h3 className="text-sm font-medium mb-3">SOC triage</h3>
              <p className="text-xs text-[var(--muted)] mb-4">
                Acknowledge, mark false positive, resolve, or reopen. If a resolved / false-positive
                finding is seen again on a later scan, it automatically reopens.
              </p>
              <form onSubmit={onTriage} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="text-[var(--muted)]">Status</span>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as FindingStatus)}
                      className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    >
                      <option value="open">Open</option>
                      <option value="acknowledged">Acknowledged</option>
                      <option value="false_positive">False positive</option>
                      <option value="resolved">Resolved</option>
                    </select>
                  </label>
                  <label className="block text-sm sm:col-span-1">
                    <span className="text-[var(--muted)]">Note</span>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={1000}
                      placeholder="Why this decision?"
                      className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-md bg-[var(--accent-dim)] px-3 py-2 text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save triage'}
                  </button>
                  {triageMessage ? (
                    <span className="text-sm text-[var(--accent)]">{triageMessage}</span>
                  ) : null}
                  {finding.triagedAt ? (
                    <span className="text-xs text-[var(--muted)]">
                      Last triaged {new Date(finding.triagedAt).toLocaleString()}
                    </span>
                  ) : null}
                </div>
              </form>
            </section>

            {repo ? (
              <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5">
                <h3 className="text-sm font-medium mb-3">Repository</h3>
                <dl className="grid gap-3 sm:grid-cols-2 text-sm">
                  <div>
                    <dt className="text-[var(--muted)]">Name</dt>
                    <dd className="mt-1 flex items-center gap-2">
                      {repo.fullName}
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)]"
                        aria-label="Open on GitHub"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">Owner</dt>
                    <dd className="mt-1">{repo.owner}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-[var(--muted)]">Description</dt>
                    <dd className="mt-1">{repo.description || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">Stars / Forks</dt>
                    <dd className="mt-1">
                      {repo.stars} / {repo.forks}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">Created / Pushed</dt>
                    <dd className="mt-1">
                      {repo.githubCreatedAt
                        ? new Date(repo.githubCreatedAt).toLocaleDateString()
                        : '—'}{' '}
                      /{' '}
                      {repo.githubPushedAt
                        ? new Date(repo.githubPushedAt).toLocaleDateString()
                        : '—'}
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}

            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5">
              <h3 className="text-sm font-medium mb-1">Triggered rules</h3>
              <p className="text-xs text-[var(--muted)] mb-4">
                Every rule that fired against{' '}
                <span className="text-[var(--text)]">{repo?.fullName || finding.summary}</span>,
                with exactly what was matched and, for file-based rules, precisely where.
              </p>

              {(finding.detections || []).length === 0 ? (
                <p className="text-sm text-[var(--muted)]">
                  No rule detail is attached to this finding yet. This can happen if it was
                  created before this page tracked per-rule evidence - re-running a scan on this
                  repository will repopulate it.
                </p>
              ) : (
                <>
                  {/* Systematic summary: repo -> file -> line -> category, at a glance */}
                  <div className="overflow-x-auto rounded-lg border border-[var(--border)] mb-5">
                    <table className="min-w-full text-sm">
                      <thead className="bg-[var(--bg)] text-left text-[var(--muted)]">
                        <tr>
                          <th className="px-4 py-2.5 font-medium">Category</th>
                          <th className="px-4 py-2.5 font-medium">Rule</th>
                          <th className="px-4 py-2.5 font-medium">File</th>
                          <th className="px-4 py-2.5 font-medium">Line</th>
                          <th className="px-4 py-2.5 font-medium">Severity</th>
                          <th className="px-4 py-2.5 font-medium">Confidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(finding.detections || []).map((d) => (
                          <tr key={`row-${d._id || d.ruleId}`} className="border-t border-[var(--border)]">
                            <td className="px-4 py-2.5">{d.category.replace(/_/g, ' ')}</td>
                            <td className="px-4 py-2.5">{d.ruleName}</td>
                            <td className="px-4 py-2.5 font-[family-name:var(--font-mono)]">
                              {d.file ? (
                                repo?.url ? (
                                  <a
                                    href={`${repo.url}/blob/HEAD/${d.file}${d.lineNumber ? `#L${d.lineNumber}` : ''}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[var(--accent)] hover:underline"
                                  >
                                    {d.file}
                                  </a>
                                ) : (
                                  d.file
                                )
                              ) : (
                                <span className="text-[var(--muted)] font-sans">repo metadata</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-[var(--muted)]">{d.lineNumber || '—'}</td>
                            <td className="px-4 py-2.5">
                              <SeverityBadge severity={d.severity} />
                            </td>
                            <td className="px-4 py-2.5 text-[var(--muted)]">
                              {(d.confidence * 100).toFixed(0)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Full evidence per rule, for anyone who wants the complete story */}
                  <ul className="space-y-3">
                    {(finding.detections || []).map((d) => (
                      <li key={d._id || d.ruleId} className="border border-[var(--border)] rounded-md p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{d.ruleName}</span>
                          <SeverityBadge severity={d.severity} />
                          <span className="text-xs text-[var(--muted)]">
                            confidence {(d.confidence * 100).toFixed(0)}% · +{d.riskContribution} pts
                          </span>
                        </div>

                        {d.file ? (
                          <p className="mt-2 text-xs">
                            <span className="text-[var(--muted)]">Found in: </span>
                            {repo?.url ? (
                              <a
                                href={`${repo.url}/blob/HEAD/${d.file}${d.lineNumber ? `#L${d.lineNumber}` : ''}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-[family-name:var(--font-mono)] text-[var(--accent)] hover:underline"
                              >
                                {d.file}
                                {d.lineNumber ? `:${d.lineNumber}` : ''}
                              </a>
                            ) : (
                              <span className="font-[family-name:var(--font-mono)]">
                                {d.file}
                                {d.lineNumber ? `:${d.lineNumber}` : ''}
                              </span>
                            )}
                          </p>
                        ) : (
                          <p className="mt-2 text-xs text-[var(--muted)]">
                            Based on repository metadata (name, description, topics) - not tied to
                            a single file.
                          </p>
                        )}

                        <p className="mt-2 text-sm">
                          <span className="text-[var(--muted)]">Why flagged: </span>
                          {d.explanation}
                        </p>

                        <p className="mt-2 text-xs font-[family-name:var(--font-mono)] text-[var(--muted)] break-all">
                          Evidence: {d.evidence}
                        </p>

                        {d.matchedText && d.matchedText !== d.evidence ? (
                          <p className="mt-1 text-xs font-[family-name:var(--font-mono)] text-[var(--text)] break-all">
                            Matched: {d.matchedText}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5">
              <h3 className="text-sm font-medium mb-3">Risk score explanation</h3>
              <ul className="space-y-2 text-sm">
                {(finding.riskBreakdown || []).map((item, idx) => (
                  <li key={`${item.factor}-${idx}`} className="flex gap-3">
                    <span
                      className="font-[family-name:var(--font-mono)] min-w-12"
                      style={{ color: item.points >= 0 ? 'var(--high)' : 'var(--low)' }}
                    >
                      {item.points >= 0 ? '+' : ''}
                      {item.points}
                    </span>
                    <span>
                      <strong>{item.factor}</strong> — {item.detail}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-[var(--muted)]">
                Last seen:{' '}
                {finding.lastSeenAt ? new Date(finding.lastSeenAt).toLocaleString() : '—'}
              </p>
            </section>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
