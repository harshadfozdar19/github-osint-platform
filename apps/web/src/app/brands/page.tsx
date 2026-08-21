'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
} from '@/components/ui';
import { TagInput } from '@/components/TagInput';
import { api, Brand } from '@/lib/api';

/** Per-keyword lifetime discovery total (GET /scans/active-by-keyword) - reposDiscovered there is summed across EVERY scan ever run for that keyword, not just active ones, so it's already a running lifetime count. */
type ActiveByKeywordEntry = { reposDiscovered: number };
type ActiveByKeyword = Record<string, ActiveByKeywordEntry>;

type BrandForm = {
  name: string;
  description: string;
  aliases: string[];
  keywords: string[];
  trustedGithubOwners: string[];
  enabled: boolean;
};

const emptyForm: BrandForm = {
  name: '',
  description: '',
  aliases: [],
  keywords: [],
  trustedGithubOwners: [],
  enabled: true,
};

/** Shared field set for both the "Add company" card and the edit modal - so the two forms can't silently drift apart. */
function BrandFormFields({
  form,
  setForm,
}: {
  form: BrandForm;
  setForm: (next: BrandForm) => void;
}) {
  return (
    <>
      <Field label="Company name" className="sm:col-span-2">
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="PhonePe"
        />
      </Field>
      <Field label="Description" className="sm:col-span-2">
        <Input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <Field label="Aliases">
        <TagInput
          values={form.aliases}
          onChange={(next) => setForm({ ...form, aliases: next })}
          placeholder="phone pe"
        />
      </Field>
      <Field label="Search keywords">
        <TagInput
          values={form.keywords}
          onChange={(next) => setForm({ ...form, keywords: next })}
          placeholder="phonepe"
        />
      </Field>
      <Field
        label="Trusted GitHub owners"
        className="sm:col-span-2"
        hint="This company's own real GitHub org/user accounts, if known. Every public repo they own gets scanned unconditionally - this is what catches your own team accidentally leaving a real secret in a public repo, not just impersonators."
      >
        <TagInput
          values={form.trustedGithubOwners}
          onChange={(next) => setForm({ ...form, trustedGithubOwners: next })}
          placeholder="angel-one-tech"
        />
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <Checkbox
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Enabled for scans
      </label>
    </>
  );
}

export default function BrandsPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<BrandForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  // The company currently open in the edit modal, and its own draft form -
  // fully separate from `form` above (the "Add company" card's own draft),
  // so editing one company can never bleed into the add-a-new-company form.
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [editForm, setEditForm] = useState<BrandForm>(emptyForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  // brandId -> keyword -> lifetime repos discovered (every scan ever run for
  // that keyword, not just the currently active one) - see loadKeywordTotals.
  const [keywordTotals, setKeywordTotals] = useState<
    Record<string, Record<string, number>>
  >({});

  async function load() {
    setLoading(true);
    try {
      const res = await api<Brand[]>('/brands');
      setBrands(res);
      loadKeywordTotals(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load companies');
    } finally {
      setLoading(false);
    }
  }

  /** Fetches each brand's own lifetime-per-keyword discovery totals in parallel - best-effort, a brand whose fetch fails just shows no counts instead of blocking the page. */
  function loadKeywordTotals(brandList: Brand[]) {
    Promise.all(
      brandList
        .filter((b) => b.keywords.length > 0)
        .map((b) =>
          api<ActiveByKeyword>(`/scans/active-by-keyword?brandId=${b._id}`)
            .then((res) => [b._id, res] as const)
            .catch(() => [b._id, {} as ActiveByKeyword] as const),
        ),
    ).then((pairs) => {
      setKeywordTotals((prev) => {
        const next = { ...prev };
        for (const [brandId, res] of pairs) {
          next[brandId] = Object.fromEntries(
            Object.entries(res).map(([keyword, entry]) => [
              keyword,
              entry.reposDiscovered,
            ]),
          );
        }
        return next;
      });
    });
  }

  useEffect(() => {
    load();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api('/brands', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          aliases: form.aliases,
          keywords: form.keywords,
          trustedGithubOwners: form.trustedGithubOwners,
          enabled: form.enabled,
        }),
      });
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(brand: Brand) {
    setEditError('');
    setEditingBrand(brand);
    setEditForm({
      name: brand.name,
      description: brand.description || '',
      aliases: brand.aliases,
      keywords: brand.keywords,
      trustedGithubOwners: brand.trustedGithubOwners || [],
      enabled: brand.enabled,
    });
  }

  async function onEditSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editingBrand || !editForm.name.trim()) return;
    setEditSaving(true);
    setEditError('');
    try {
      await api(`/brands/${editingBrand._id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim(),
          aliases: editForm.aliases,
          keywords: editForm.keywords,
          trustedGithubOwners: editForm.trustedGithubOwners,
          enabled: editForm.enabled,
        }),
      });
      setEditingBrand(null);
      await load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setEditSaving(false);
    }
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
      if (editingBrand?._id === id) setEditingBrand(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <RequireAuth>
      <AppShell title="Monitored companies">
        <Card className="mb-6 p-4">
          <h3 className="mb-3 text-sm font-semibold text-[var(--muted)]">Add company</h3>
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <BrandFormFields form={form} setForm={setForm} />
            <div className="sm:col-span-2">
              <Button type="submit" loading={saving}>
                {saving ? 'Saving…' : 'Add company'}
              </Button>
            </div>
          </form>
        </Card>

        {error ? <ErrorState message={error} /> : null}
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <CardSkeleton count={3} />
          </div>
        ) : null}
        {!loading && brands.length === 0 ? (
          <EmptyState title="No companies" body="Add a monitored company to include it in scan queries." />
        ) : null}

        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {brands.map((b) => (
            <Card key={b._id} as="li" hoverable className="min-w-0 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="break-words font-medium">{b.name}</h3>
                  {b.description ? (
                    <p className="mt-1 break-words text-xs text-[var(--muted)]">
                      {b.description}
                    </p>
                  ) : null}
                  <p className="mt-1 break-words text-xs text-[var(--muted)]">
                    Aliases: {b.aliases.join(', ') || '—'}
                  </p>
                  <div className="mt-1.5">
                    <p className="text-xs text-[var(--muted)]">
                      Keywords{' '}
                      {b.keywords.length > 0 ? (
                        <span className="text-[10px]">
                          (lifetime repos discovered, all scans ever run)
                        </span>
                      ) : null}
                    </p>
                    {b.keywords.length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">—</p>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {b.keywords.map((keyword) => (
                          <Badge
                            key={keyword}
                            tone="muted"
                            wrap
                            className="max-w-full font-[family-name:var(--font-mono)] normal-case"
                          >
                            <span className="break-words">{keyword}</span>
                            <span style={{ color: 'var(--accent)' }}>
                              {keywordTotals[b._id]?.[keyword] ?? 0}
                            </span>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="mt-1 break-words text-xs text-[var(--muted)]">
                    Trusted owners: {(b.trustedGithubOwners || []).join(', ') || '—'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(b)}
                  className="shrink-0"
                  aria-pressed={b.enabled}
                >
                  <Badge tone={b.enabled ? 'success' : 'muted'} className="cursor-pointer normal-case">
                    {b.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </button>
              </div>
              <div className="mt-3 flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => startEdit(b)}
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(b._id)}
                  className="font-medium text-[var(--danger)] hover:underline"
                >
                  Delete
                </button>
              </div>
            </Card>
          ))}
        </ul>

        {editingBrand ? (
          <Modal title={`Edit — ${editingBrand.name}`} onClose={() => setEditingBrand(null)}>
            <form onSubmit={onEditSubmit} className="grid gap-4">
              <BrandFormFields form={editForm} setForm={setEditForm} />
              {editError ? <ErrorState message={editError} /> : null}
              <div className="flex gap-2">
                <Button type="submit" loading={editSaving}>
                  {editSaving ? 'Saving…' : 'Save changes'}
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditingBrand(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Modal>
        ) : null}
      </AppShell>
    </RequireAuth>
  );
}
