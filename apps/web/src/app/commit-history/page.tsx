'use client';

import { FormEvent, useEffect, useState } from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  TableSkeleton,
} from '@/components/ui';
import { api, ApiError, TrackedGithubUser } from '@/lib/api';
import { formatDateTime } from '@/lib/date';
import { openExternalLink } from '@/lib/external-link';

export default function CommitHistoryPage() {
  const [users, setUsers] = useState<TrackedGithubUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError('');
    api<TrackedGithubUser[]>('/tracked-users')
      .then(setUsers)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setAdding(true);
    setError('');
    try {
      const created = await api<TrackedGithubUser>('/tracked-users', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), note: note.trim() || undefined }),
      });
      setUsers((prev) => [created, ...(prev ?? [])]);
      setUsername('');
      setNote('');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to add user',
      );
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(id: string) {
    if (!window.confirm('Stop tracking this user?')) return;
    setRemovingId(id);
    setError('');
    try {
      await api(`/tracked-users/${id}`, { method: 'DELETE' });
      setUsers((prev) => (prev ?? []).filter((u) => u._id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <RequireAuth>
      <AppShell
        title="Commit History"
        subtitle="Track GitHub usernames and jump straight to everything public they've committed."
      >
        <Card className="mb-6 p-4">
          <p className="mb-3 text-sm text-[var(--muted)]">
            Add a GitHub username to keep an eye on. Nothing is fetched or stored here beyond the
            username itself - each entry just links straight to{' '}
            <span className="font-[family-name:var(--font-mono)] text-xs">
              github.com/search?q=author:&lt;username&gt;
            </span>
            , GitHub&apos;s own commit search for that person, sorted newest first.
          </p>
          <form onSubmit={onAdd} className="flex flex-wrap items-end gap-3">
            <Field label="GitHub username" className="min-w-[200px]">
              <Input
                placeholder="e.g. octocat"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field label="Note (optional)" className="min-w-[240px] flex-1">
              <Input
                placeholder="e.g. found via a fake-apk repo"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={adding} disabled={!username.trim()}>
              {adding ? 'Adding…' : 'Add user'}
            </Button>
          </form>
        </Card>

        {error ? (
          <div className="mb-4">
            <ErrorState message={error} onRetry={load} />
          </div>
        ) : null}
        {loading ? <TableSkeleton rows={4} cols={3} /> : null}

        {!loading && users && users.length === 0 ? (
          <EmptyState
            title="No users tracked yet"
            body="Add a GitHub username above to start tracking their commit activity."
          />
        ) : null}

        {!loading && users && users.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {users.map((u) => (
              <li key={u._id}>
                <Card className="flex flex-wrap items-center gap-3 p-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                    <GitCommitHorizontal className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{u.username}</p>
                    {u.note ? (
                      <p className="truncate text-xs text-[var(--muted)]" title={u.note}>
                        {u.note}
                      </p>
                    ) : null}
                    {u.createdAt ? (
                      <p className="text-[11px] text-[var(--muted)]">
                        Tracked since {formatDateTime(u.createdAt)}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openExternalLink(u.commitSearchUrl)}
                  >
                    View commits on GitHub →
                  </Button>
                  <button
                    type="button"
                    onClick={() => onRemove(u._id)}
                    disabled={removingId === u._id}
                    className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--danger)] hover:border-[var(--danger)] disabled:opacity-40"
                    title="Stop tracking this user"
                    aria-label={`Stop tracking ${u.username}`}
                  >
                    {removingId === u._id ? 'Removing…' : 'Remove'}
                  </button>
                </Card>
              </li>
            ))}
          </ul>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
