'use client';

import { KeyboardEvent, useState } from 'react';
import { X } from 'lucide-react';
import { Badge, Button, Input } from '@/components/ui';

/**
 * Add-one-at-a-time chip input, replacing a single "type it comma-separated"
 * text field: type a value, click Add (or press Enter), it becomes a
 * removable chip. Avoids the ambiguity of a raw comma-separated string
 * (what if a value itself needs a comma, was that trailing space intentional,
 * etc.) and makes the current list directly visible/editable instead of
 * buried in one long line of text.
 */
export function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...values, trimmed]);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  return (
    <div className="min-w-0">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="min-w-0 flex-1"
        />
        <Button type="button" variant="outline" onClick={commit} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      {values.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v, i) => (
            <Badge key={`${v}-${i}`} tone="muted" wrap className="max-w-full normal-case">
              <span className="break-words">{v}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="shrink-0 text-[var(--muted)] hover:text-[var(--danger)]"
                aria-label={`Remove "${v}"`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
