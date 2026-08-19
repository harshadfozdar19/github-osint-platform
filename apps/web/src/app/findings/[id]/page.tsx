'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ExternalLink, Rocket, Users } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Select,
  SeverityBadge,
} from '@/components/ui';
import {
  api,
  BrandMatchEvidence,
  CredentialVerification,
  Detection,
  Finding,
  Repository,
} from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/date';
import { openExternalLink } from '@/lib/external-link';

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

function matchLocationLabel(location: string) {
  switch (location) {
    case 'owner':
      return "the repo's owner account";
    case 'repo_name':
      return "the repo's name";
    case 'description':
      return 'the repo description';
    case 'topics':
      return 'the repo topics';
    case 'file_path':
      return 'a file or folder name in the repo';
    case 'readme':
      return 'the README';
    case 'file_content':
      return 'a file in the repo';
    case 'commit_message':
      return 'a commit message';
    case 'commit_author':
      return 'a commit author name';
    default:
      return location;
  }
}

function BrandMatchBadge({ evidence }: { evidence: BrandMatchEvidence }) {
  if (evidence.type === 'trusted_owner') {
    return (
      <span
        title={`This repo is owned by a GitHub account you've registered as belonging to this brand (${evidence.matchedAlias}).`}
      >
        <Badge tone="accent">Verified account</Badge>
      </span>
    );
  }
  const label = evidence.type === 'exact' ? 'Exact match' : 'Fuzzy match';
  return (
    <span
      title={`"${evidence.matchedAlias}" found in ${matchLocationLabel(evidence.location)}: ${evidence.matchedText}`}
    >
      <Badge tone="muted">
        {label} in {matchLocationLabel(evidence.location)}
      </Badge>
    </span>
  );
}

/**
 * The badge alone only names the *kind* of location ("Exact match in a file
 * in the repo") - not specific enough to act on without re-searching the
 * whole repo. This renders the actual location: the metadata value itself
 * for owner/repo-name/description/topics/path matches, or `file:line` for
 * README/file-content matches, always visible rather than buried in a hover
 * title.
 */
function BrandMatchLocationDetail({ evidence }: { evidence: BrandMatchEvidence }) {
  const where =
    evidence.location === 'file_content' && evidence.filePath
      ? `${evidence.filePath}${evidence.lineNumber ? `:${evidence.lineNumber}` : ''}`
      : evidence.location === 'readme' && evidence.lineNumber
        ? `README, line ${evidence.lineNumber}`
        : matchLocationLabel(evidence.location);

  return (
    <p className="mt-1 text-xs text-[var(--muted)] font-mono break-all">
      {where}: <span className="text-[var(--fg)]">&quot;{evidence.matchedText}&quot;</span>
    </p>
  );
}

function linkKindLabel(kind: string) {
  switch (kind) {
    case 'email':
      return 'Email';
    case 'telegram':
      return 'Telegram';
    case 'whatsapp':
      return 'WhatsApp';
    case 'discord_invite':
      return 'Discord';
    case 'crypto_wallet':
      return 'Wallet';
    default:
      return kind;
  }
}

function verificationTone(status: CredentialVerification['status']) {
  switch (status) {
    case 'active':
      return 'var(--danger)';
    case 'invalid':
      return 'var(--muted)';
    case 'error':
      return 'var(--high)';
    default:
      return 'var(--muted)';
  }
}

function verificationLabel(status: CredentialVerification['status']) {
  switch (status) {
    case 'active':
      return 'Verified ACTIVE';
    case 'invalid':
      return 'Not currently valid';
    case 'unsupported':
      return 'Cannot be safely verified';
    case 'error':
      return 'Check failed';
    default:
      return status;
  }
}

/**
 * Manual, per-detection trigger only - never fires automatically. Verifying
 * makes a live, read-only call against the credential's own provider (e.g.
 * GitHub /user, Stripe /v1/balance), so it's deliberately gated behind an
 * explicit click rather than running for every exposed-secret finding on
 * every scan.
 */
function VerifyCredentialButton({
  findingId,
  detection,
  onVerified,
}: {
  findingId: string;
  detection: Detection;
  onVerified: (result: CredentialVerification) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  if (detection.category !== 'exposed_secret') return null;

  async function onClick() {
    setChecking(true);
    setError('');
    try {
      const result = await api<CredentialVerification>(
        `/findings/${findingId}/detections/${detection._id}/verify`,
        { method: 'POST' },
      );
      onVerified(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onClick} loading={checking}>
        {checking ? 'Checking…' : 'Verify credential'}
      </Button>
      {detection.verification ? (
        <span
          className="rounded-lg px-2 py-0.5 text-xs font-medium"
          style={{
            color: verificationTone(detection.verification.status),
            background: `${verificationTone(detection.verification.status)}1a`,
            border: `1px solid ${verificationTone(detection.verification.status)}55`,
          }}
          title={detection.verification.detail}
        >
          {verificationLabel(detection.verification.status)}
        </span>
      ) : null}
      {error ? <span className="text-xs text-[var(--danger)]">{error}</span> : null}
    </div>
  );
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

  function onDetectionVerified(detectionId: string, result: CredentialVerification) {
    setFinding((prev) =>
      prev
        ? {
            ...prev,
            detections: (prev.detections || []).map((d) =>
              d._id === detectionId ? { ...d, verification: result } : d,
            ),
          }
        : prev,
    );
  }

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
  const keywordMatchDetections = (finding?.detections || []).filter(
    (d) => d.ruleId === 'custom-keyword-match',
  );

  return (
    <RequireAuth>
      <AppShell title="Finding detail" subtitle="Repository context, triage, and score explanation.">
        <p className="mb-4">
          <Link href="/findings" className="text-sm text-[var(--accent)] hover:underline">
            ← Back to findings
          </Link>
        </p>
        {loading ? <LoadingBlock /> : null}
        {error ? <ErrorState message={error} /> : null}
        {finding ? (
          <div className="space-y-6">
            <Card className="p-5">
              <div className="flex flex-wrap items-center gap-3">
                <SeverityBadge severity={finding.severity} />
                <span className="font-[family-name:var(--font-mono)] text-2xl">
                  {finding.riskScore}
                </span>
                <Badge tone="muted">{statusLabel(finding.status)}</Badge>
                {finding.origin ? (
                  <Badge tone={finding.origin === 'internal' ? 'danger' : 'muted'}>
                    {finding.origin === 'internal' ? 'INTERNAL — OUR OWN REPO' : 'EXTERNAL'}
                  </Badge>
                ) : null}
                {finding.lastChangeType === 'reopened' ? (
                  <Badge tone="warning">
                    REOPENED
                    {finding.reopenedAt ? ` · ${formatDateTime(finding.reopenedAt)}` : ''}
                  </Badge>
                ) : null}
                {finding.isDemo ? <Badge tone="warning">DEMO</Badge> : null}
              </div>
              <h2 className="mt-3 text-xl font-semibold tracking-tight">{finding.summary}</h2>
              {finding.origin === 'internal' ? (
                <Alert tone="danger" className="mt-2 font-medium">
                  This was found in one of your own trusted GitHub accounts&apos; repos, not an
                  impersonator&apos;s. If this is an exposed credential, rotate it now — do not
                  wait to report or take anything down.
                </Alert>
              ) : finding.origin === 'external' ? (
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Found in a repo that is not one of this brand&apos;s own trusted GitHub
                  accounts. If this is impersonation, phishing, or a scam using your name, the
                  next step is reporting/requesting a takedown — not credential rotation.
                </p>
              ) : null}
              <p className="mt-2 text-sm text-[var(--muted)] flex flex-wrap items-center gap-2">
                <span>
                  Brand: {finding.brandName || '—'} · Categories:{' '}
                  {finding.categories?.map((c) => c.replace(/_/g, ' ')).join(', ')}
                </span>
                {finding.brandMatchEvidence ? (
                  <BrandMatchBadge evidence={finding.brandMatchEvidence} />
                ) : null}
              </p>
              {finding.brandMatchEvidence ? (
                <BrandMatchLocationDetail evidence={finding.brandMatchEvidence} />
              ) : null}
              {finding.brandMatchEvidence &&
              finding.brandMatchEvidence.type !== 'trusted_owner' ? (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  This is a heuristic - the brand name showed up somewhere in the
                  repo, which doesn&apos;t by itself prove this repo is really about that
                  brand. Worth a quick look at the evidence before acting on it.
                </p>
              ) : null}
            </Card>

            <Card className="p-5">
              <h3 className="text-sm font-medium mb-3">SOC triage</h3>
              <p className="text-xs text-[var(--muted)] mb-4">
                Acknowledge, mark false positive, resolve, or reopen. If a resolved / false-positive
                finding is seen again on a later scan, it automatically reopens.
              </p>
              <form onSubmit={onTriage} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Status">
                    <Select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as FindingStatus)}
                    >
                      <option value="open">Open</option>
                      <option value="acknowledged">Acknowledged</option>
                      <option value="false_positive">False positive</option>
                      <option value="resolved">Resolved</option>
                    </Select>
                  </Field>
                  <Field label="Note">
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={1000}
                      placeholder="Why this decision?"
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" loading={saving}>
                    {saving ? 'Saving…' : 'Save triage'}
                  </Button>
                  {triageMessage ? (
                    <span className="text-sm text-[var(--accent)]">{triageMessage}</span>
                  ) : null}
                  {finding.triagedAt ? (
                    <span className="text-xs text-[var(--muted)]">
                      Last triaged {formatDateTime(finding.triagedAt)}
                    </span>
                  ) : null}
                </div>
              </form>
            </Card>

            {repo ? (
              <Card className="p-5">
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
                      {formatDate(repo.githubCreatedAt)} / {formatDate(repo.githubPushedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">Keywords matched</dt>
                    <dd className="mt-1 font-[family-name:var(--font-mono)]">
                      {finding.keywordMatchCount ?? 0}
                    </dd>
                  </div>
                  {repo.deployment ? (
                    <div className="sm:col-span-2">
                      <dt className="text-[var(--muted)] flex items-center gap-1.5">
                        <Rocket className="h-3.5 w-3.5" />
                        Deployed
                      </dt>
                      <dd className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{repo.deployment.environment}</Badge>
                        <button
                          type="button"
                          onClick={() => openExternalLink(repo.deployment!.url)}
                          className="text-[var(--accent)] hover:underline break-all text-left"
                        >
                          {repo.deployment.url}
                        </button>
                        {repo.deployment.state !== 'success' ? (
                          <span className="text-xs text-[var(--muted)]">
                            ({repo.deployment.state})
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </Card>
            ) : null}

            {(finding.contributors || []).length > 0 ? (
              <Card className="p-5">
                <h3 className="text-sm font-medium mb-1 flex items-center gap-1.5">
                  <Users className="h-4 w-4" />
                  Contributors ({(finding.contributors || []).length})
                </h3>
                <p className="text-xs text-[var(--muted)] mb-4">
                  Everyone with commits on this repo, and any other repos in this workspace
                  they&apos;ve also contributed to.
                </p>
                <ul className="space-y-2">
                  {(finding.contributors || []).map((c) => (
                    <li
                      key={c.login}
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={`https://github.com/${c.login}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--accent)] hover:underline font-medium"
                        >
                          {c.login}
                        </a>
                        <span className="text-xs text-[var(--muted)]">
                          {c.contributions} commit{c.contributions === 1 ? '' : 's'} here
                        </span>
                      </div>
                      {c.otherRepositories.length > 0 ? (
                        <div className="mt-1.5 text-xs text-[var(--muted)]">
                          Also contributed to:{' '}
                          {c.otherRepositories.map((r, idx) => (
                            <span key={r.repositoryId}>
                              {idx > 0 ? ', ' : ''}
                              <a
                                href={`https://github.com/${r.fullName}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[var(--accent)] hover:underline"
                              >
                                {r.fullName}
                              </a>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {keywordMatchDetections.length > 0 ? (
              <Card className="p-5">
                <h3 className="text-sm font-medium mb-1">
                  Curated keywords matched ({keywordMatchDetections.length})
                </h3>
                <p className="text-xs text-[var(--muted)] mb-4">
                  This brand&apos;s own curated risk keywords found in this repository - see
                  &quot;Triggered rules&quot; below for full evidence on every rule, including these.
                </p>
                <ul className="space-y-2">
                  {keywordMatchDetections.map((d) => (
                    <li
                      key={d._id || d.evidence}
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                    >
                      {d.evidence}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {(finding.linkedIdentities || []).length > 0 ? (
              <Card className="border-[var(--high)]/40 bg-[var(--high)]/5 p-5">
                <h3 className="text-sm font-medium mb-1 text-[var(--high)]">
                  Linked to other GitHub identities
                </h3>
                <p className="text-xs text-[var(--muted)] mb-4">
                  This repo shares a contact detail or wallet address with the account
                  {(finding.linkedIdentities || []).length === 1 ? '' : 's'} below - GitHub logins
                  are disposable, but the payout/contact channel behind them usually isn&apos;t.
                  Worth reporting together.
                </p>
                <ul className="space-y-2">
                  {(finding.linkedIdentities || []).map((link, idx) => (
                    <li
                      key={`${link.kind}-${link.value}-${idx}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                    >
                      <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--high)] border border-[var(--high)]/40">
                        {linkKindLabel(link.kind)}
                      </span>
                      <span className="font-[family-name:var(--font-mono)] break-all">
                        {link.value}
                      </span>
                      <span className="text-[var(--muted)]">via</span>
                      <a
                        href={`https://github.com/${link.owner}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)] hover:underline"
                      >
                        {link.fullName}
                      </a>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <Card className="p-5">
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
                    <table className="min-w-[700px] w-full text-sm">
                      <thead className="bg-[var(--bg-subtle)] text-left text-[var(--muted)]">
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
                          <tr
                            key={`row-${d._id || d.ruleId}`}
                            className="border-t border-[var(--border)] transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
                          >
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              {d.category.replace(/_/g, ' ')}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap">{d.ruleName}</td>
                            <td className="px-4 py-2.5 whitespace-nowrap font-[family-name:var(--font-mono)]">
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
                            <td className="px-4 py-2.5 whitespace-nowrap text-[var(--muted)]">
                              {d.lineNumber || '—'}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <SeverityBadge severity={d.severity} />
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-[var(--muted)]">
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
                      <li key={d._id || d.ruleId} className="border border-[var(--border)] rounded-lg p-3">
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

                        <VerifyCredentialButton
                          findingId={finding._id}
                          detection={d}
                          onVerified={(result) => onDetectionVerified(d._id, result)}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>

            <Card className="p-5">
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
                Last seen: {formatDateTime(finding.lastSeenAt)}
              </p>
            </Card>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
