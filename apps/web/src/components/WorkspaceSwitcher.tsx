'use client';

import { useEffect, useState } from 'react';
import {
  api,
  getWorkspaceId,
  setWorkspaceId,
  WorkspaceSummary,
} from '@/lib/api';

let cachedWorkspacesPromise: Promise<WorkspaceSummary[]> | null = null;

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!cachedWorkspacesPromise) {
      cachedWorkspacesPromise = api<WorkspaceSummary[]>('/workspaces', { workspace: false });
    }
    cachedWorkspacesPromise
      .then((list) => {
        setWorkspaces(list);
        const saved = getWorkspaceId();
        const initial =
          (saved && list.find((w) => w._id === saved)?._id) ||
          list[0]?._id ||
          '';
        if (initial) {
          setWorkspaceId(initial);
          setCurrentId(initial);
        }
      })
      .catch((err) => {
        cachedWorkspacesPromise = null;
        setError(err instanceof Error ? err.message : 'Failed to load workspaces');
      })
      .finally(() => setLoading(false));
  }, []);

  async function onChange(id: string) {
    setError('');
    try {
      await api<WorkspaceSummary>(`/workspaces/${id}/switch`, {
        method: 'POST',
        workspace: false,
      });
      cachedWorkspacesPromise = null;
      setWorkspaceId(id);
      setCurrentId(id);
      // Reload tenant-scoped pages with the new workspace context.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Switch failed');
    }
  }

  if (loading) {
    return (
      <p className="px-2 text-xs text-[var(--muted)]" aria-live="polite">
        Loading workspaces…
      </p>
    );
  }

  if (workspaces.length === 0) {
    return (
      <p className="px-2 text-xs text-[var(--muted)]">No workspaces available</p>
    );
  }

  return (
    <div className="px-2 space-y-1">
      <label htmlFor="workspace-switcher" className="text-xs text-[var(--muted)]">
        Workspace
      </label>
      <select
        id="workspace-switcher"
        value={currentId}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
      >
        {workspaces.map((ws) => (
          <option key={ws._id} value={ws._id}>
            {ws.name}
            {ws.role ? ` (${ws.role})` : ''}
          </option>
        ))}
      </select>
      {error ? (
        <p className="text-xs text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
