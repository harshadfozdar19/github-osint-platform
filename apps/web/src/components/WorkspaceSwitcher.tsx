'use client';

import { useEffect, useState } from 'react';
import {
  api,
  getWorkspaceId,
  getWorkspacesCache,
  setWorkspaceId,
  setWorkspacesCache,
  WorkspaceSummary,
} from '@/lib/api';

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let promise = getWorkspacesCache<WorkspaceSummary[]>();
    if (!promise) {
      promise = api<WorkspaceSummary[]>('/workspaces', { workspace: false });
      setWorkspacesCache(promise);
    }
    promise
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
        setWorkspacesCache(null);
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
      setWorkspacesCache(null);
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
      <p className="px-2 text-xs" style={{ color: '#ffffff' }} aria-live="polite">
        Loading workspaces…
      </p>
    );
  }

  if (workspaces.length === 0) {
    return (
      <p className="px-2 text-xs" style={{ color: '#ffffff' }}>No workspaces available</p>
    );
  }

  return (
    <div className="px-1 space-y-1.5">
      <label
        htmlFor="workspace-switcher"
        className="px-2 text-[11px] font-semibold uppercase tracking-wider text-white"
      >
        Workspace
      </label>
      <select
        id="workspace-switcher"
        value={currentId}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--sidebar-border)] bg-[var(--sidebar-card-bg)] px-2.5 py-2 text-sm font-medium text-white outline-none transition-colors duration-150 focus:border-[var(--accent)]"
      >
        {workspaces.map((ws) => (
          // Inline style, not just className - the popup option list is
          // browser-native chrome that mostly ignores Tailwind classes on
          // <option>, but Chromium/Firefox do honor inline color/background
          // set directly here, which is what keeps this text white-on-dark
          // instead of falling back to the OS default (black-on-white).
          <option
            key={ws._id}
            value={ws._id}
            style={{ color: '#ffffff', background: 'var(--sidebar-card-bg)' }}
          >
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
