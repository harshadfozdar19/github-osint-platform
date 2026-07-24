'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { LoadingBlock } from '@/components/ui';
import { api, getWorkspaceId, GithubTokenStatus } from '@/lib/api';

export default function SettingsPage() {
  const [status, setStatus] = useState<GithubTokenStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api<GithubTokenStatus>(
        `/workspaces/${workspaceId}/github-token`,
        { workspace: false },
      );
      setStatus(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load token status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const workspaceId = getWorkspaceId();
    if (!workspaceId || !token.trim()) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const res = await api<GithubTokenStatus>(
        `/workspaces/${workspaceId}/github-token`,
        {
          method: 'PATCH',
          workspace: false,
          body: JSON.stringify({ token: token.trim() }),
        },
      );
      setStatus(res);
      setToken('');
      setMessage('GitHub token saved for this workspace.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setSaving(false);
    }
  }

  async function onClear() {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const res = await api<GithubTokenStatus>(
        `/workspaces/${workspaceId}/github-token`,
        { method: 'DELETE', workspace: false },
      );
      setStatus(res);
      setMessage(
        'Workspace GitHub token removed — falling back to the shared server token, if any.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear token');
    } finally {
      setSaving(false);
    }
  }

  return (
    <RequireAuth>
      <AppShell title="Settings" subtitle="Workspace-level configuration.">
        <section className="max-w-xl rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-5 space-y-4">
          <div>
            <h2 className="text-sm font-medium">GitHub token</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Optional. If set, this workspace&apos;s scans use it instead of the shared
              server token, so it draws its own GitHub quota instead of sharing one across
              every workspace. Encrypted at rest — only the last 4 characters are ever
              shown back, never the full token.
            </p>
          </div>

          {loading ? <LoadingBlock /> : null}

          {!loading && status ? (
            <p className="text-sm">
              {status.configured ? (
                <>
                  Currently configured — ending in{' '}
                  <code className="text-[var(--accent)]">•••{status.last4}</code>
                  {status.updatedAt
                    ? ` (updated ${new Date(status.updatedAt).toLocaleString()})`
                    : ''}
                </>
              ) : (
                'No workspace-specific token set — using the shared server token, if configured.'
              )}
            </p>
          ) : null}

          <form onSubmit={onSave} className="flex flex-wrap items-end gap-3">
            <label className="text-sm min-w-[240px] flex-1">
              <span className="mb-1 block text-[var(--muted)]">New token</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_..."
                autoComplete="off"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              />
            </label>
            <button
              type="submit"
              disabled={saving || !token.trim()}
              className="rounded-md bg-[var(--accent-dim)] px-4 py-2 text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {status?.configured ? (
              <button
                type="button"
                disabled={saving}
                onClick={onClear}
                className="rounded-md border border-[var(--border)] px-4 py-2 disabled:opacity-60"
              >
                Clear
              </button>
            ) : null}
          </form>

          {message ? <p className="text-sm text-[var(--accent)]">{message}</p> : null}
          {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
        </section>
      </AppShell>
    </RequireAuth>
  );
}
