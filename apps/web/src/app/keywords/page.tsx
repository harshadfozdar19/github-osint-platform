'use client';

import { FormEvent, useEffect, useState } from 'react';
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
  Select,
  TableSkeleton,
} from '@/components/ui';
import { api, Keyword } from '@/lib/api';

const CATEGORIES = ['general', 'phishing', 'malware', 'secret', 'brand'];

export default function KeywordsPage() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ keyword: '', category: 'phishing', priority: 5 });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await api<Keyword[]>('/keywords');
      setKeywords(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load keywords');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!form.keyword.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api('/keywords', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ keyword: '', category: 'phishing', priority: 5 });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(kw: Keyword) {
    try {
      await api(`/keywords/${kw._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !kw.enabled }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this keyword?')) return;
    try {
      await api(`/keywords/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <RequireAuth>
      <AppShell
        title="Search keywords"
        subtitle="Manage discovery keywords used in GitHub scan query generation. Higher priority keywords are preferred."
      >
        <Card className="mb-6 p-4">
          <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
            <Field label="Keyword">
              <Input
                value={form.keyword}
                onChange={(e) => setForm({ ...form, keyword: e.target.value })}
                placeholder="e.g. wallet"
              />
            </Field>
            <Field label="Category">
              <Select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority (1–10)">
              <Input
                type="number"
                min={1}
                max={10}
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 5 })}
                className="w-20"
              />
            </Field>
            <Button type="submit" loading={saving}>
              {saving ? 'Adding…' : 'Add keyword'}
            </Button>
          </form>
        </Card>

        {error ? <ErrorState message={error} /> : null}
        {loading ? <TableSkeleton rows={5} cols={5} /> : null}
        {!loading && keywords.length === 0 ? (
          <EmptyState title="No keywords" body="Add keywords to customize scan discovery queries." />
        ) : null}

        {!loading && keywords.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)]">
            <table className="min-w-full text-sm">
              <thead className="bg-[var(--bg-subtle)] text-left text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3">Keyword</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keywords.map((kw) => (
                  <tr
                    key={kw._id}
                    className="border-t border-[var(--border)] transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
                  >
                    <td className="px-4 py-3 font-medium">{kw.keyword}</td>
                    <td className="px-4 py-3 capitalize">{kw.category}</td>
                    <td className="px-4 py-3">{kw.priority}</td>
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => toggle(kw)}>
                        <Badge tone={kw.enabled ? 'success' : 'muted'} className="cursor-pointer normal-case">
                          {kw.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => remove(kw._id)}
                        className="text-xs font-medium text-[var(--danger)] hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
