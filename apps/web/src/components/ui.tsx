'use client';

import { FormEvent, useEffect, useState } from 'react';
import { severityColor } from '@/lib/api';

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide"
      style={{
        color: severityColor(severity),
        background: `${severityColor(severity)}22`,
        border: `1px solid ${severityColor(severity)}55`,
      }}
    >
      {severity}
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/80 p-4">
      <p className="text-xs uppercase tracking-wider text-[var(--muted)]">{label}</p>
      <p className="mt-2 text-3xl font-semibold font-[family-name:var(--font-mono)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] p-10 text-center">
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-2 text-sm text-[var(--muted)]">{body}</p>
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="animate-pulse rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/50 p-8 text-sm text-[var(--muted)]">
      {label}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const [jumpTo, setJumpTo] = useState(String(page));

  useEffect(() => setJumpTo(String(page)), [page]);

  function onJump(e: FormEvent) {
    e.preventDefault();
    const parsed = Math.trunc(Number(jumpTo));
    if (!Number.isFinite(parsed)) return;
    onChange(Math.max(1, Math.min(totalPages, parsed)));
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="rounded-md border border-[var(--border)] px-3 py-1 disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-sm text-[var(--muted)]">
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        className="rounded-md border border-[var(--border)] px-3 py-1 disabled:opacity-40"
      >
        Next
      </button>
      <form onSubmit={onJump} className="flex items-center gap-2">
        <label htmlFor="page-jump" className="text-sm text-[var(--muted)]">
          Go to page
        </label>
        <input
          id="page-jump"
          type="number"
          min={1}
          max={totalPages}
          value={jumpTo}
          onChange={(e) => setJumpTo(e.target.value)}
          className="w-16 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm"
        />
        <button
          type="submit"
          className="rounded-md border border-[var(--border)] px-3 py-1 text-sm hover:bg-[var(--bg-elevated)]"
        >
          Go
        </button>
      </form>
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="mb-4 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--warning)]">
      Demo data present — findings marked DEMO are seeded for local demonstration and are not live GitHub results.
    </div>
  );
}
