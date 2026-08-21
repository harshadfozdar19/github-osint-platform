'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { Alert, Button, Card, Field, Input, LoadingBlock } from '@/components/ui';
import { api, getWorkspaceId, GithubTokenStatus } from '@/lib/api';
import { formatDateTime } from '@/lib/date';

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
      <AppShell title="Settings">
        <Card className="max-w-xl space-y-4 p-5">
          <div>
            <h2 className="text-sm font-semibold">GitHub token</h2>
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
                  <code className="font-[family-name:var(--font-mono)] text-[var(--accent)]">
                    •••{status.last4}
                  </code>
                  {status.updatedAt ? ` (updated ${formatDateTime(status.updatedAt)})` : ''}
                </>
              ) : (
                'No workspace-specific token set — using the shared server token, if configured.'
              )}
            </p>
          ) : null}

          <form onSubmit={onSave} className="flex flex-wrap items-end gap-3">
            <Field label="New token" className="min-w-[240px] flex-1">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_..."
                autoComplete="off"
              />
            </Field>
            <Button type="submit" disabled={!token.trim()} loading={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {status?.configured ? (
              <Button type="button" variant="outline" disabled={saving} onClick={onClear}>
                Clear
              </Button>
            ) : null}
          </form>

          {message ? <Alert tone="success">{message}</Alert> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </Card>
      </AppShell>
    </RequireAuth>
  );
}
