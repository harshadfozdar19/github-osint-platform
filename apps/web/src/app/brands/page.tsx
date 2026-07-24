'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { EmptyState, LoadingBlock } from '@/components/ui';
import { api, Brand } from '@/lib/api';

type BrandForm = {
  name: string;
  description: string;
  aliases: string;
  keywords: string;
  enabled: boolean;
};

const emptyForm: BrandForm = {
  name: '',
  description: '',
  aliases: '',
  keywords: '',
  enabled: true,
};

export default function BrandsPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<BrandForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await api<Brand[]>('/brands');
      setBrands(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load companies');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function splitList(value: string) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError('');
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      aliases: splitList(form.aliases),
      keywords: splitList(form.keywords),
      enabled: form.enabled,
    };
    try {
      if (editingId) {
        await api(`/brands/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/brands', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setForm(emptyForm);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(brand: Brand) {
    setEditingId(brand._id);
    setForm({
      name: brand.name,
      description: brand.description || '',
      aliases: brand.aliases.join(', '),
      keywords: brand.keywords.join(', '),
      enabled: brand.enabled,
    });
  }

  async function toggle(brand: Brand) {
    try {
      await api(`/brands/${brand._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !brand.enabled }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this monitored company?')) return;
    try {
      await api(`/brands/${id}`, { method: 'DELETE' });
      if (editingId === id) {
        setEditingId(null);
        setForm(emptyForm);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <RequireAuth>
      <AppShell
        title="Monitored companies"
        subtitle="Create, edit, and enable brands used in GitHub OSINT scan queries."
      >
        <form
          onSubmit={onSubmit}
          className="mb-6 grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4 sm:grid-cols-2"
        >
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-[var(--muted)]">Company name</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              placeholder="PhonePe"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-[var(--muted)]">Description</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">Aliases (comma-separated)</span>
            <input
              value={form.aliases}
              onChange={(e) => setForm({ ...form, aliases: e.target.value })}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              placeholder="phonepe, phone pe"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">Search keywords (comma-separated)</span>
            <input
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              placeholder="phonepe"
            />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Enabled for scans
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-[var(--accent-dim)] px-4 py-2 text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
            >
              {saving ? 'Saving…' : editingId ? 'Update company' : 'Add company'}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(emptyForm);
                }}
                className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>

        {error ? <p className="mb-4 text-[var(--danger)]">{error}</p> : null}
        {loading ? <LoadingBlock /> : null}
        {!loading && brands.length === 0 ? (
          <EmptyState title="No companies" body="Add a monitored company to include it in scan queries." />
        ) : null}

        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {brands.map((b) => (
            <li
              key={b._id}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/70 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">{b.name}</h3>
                  {b.description ? (
                    <p className="mt-1 text-xs text-[var(--muted)]">{b.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Aliases: {b.aliases.join(', ') || '—'}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Keywords: {b.keywords.join(', ') || '—'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(b)}
                  className="rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:border-[var(--accent)]"
                  aria-pressed={b.enabled}
                >
                  {b.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <div className="mt-3 flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => startEdit(b)}
                  className="text-[var(--accent)] hover:underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(b._id)}
                  className="text-[var(--danger)] hover:underline"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </AppShell>
    </RequireAuth>
  );
}
