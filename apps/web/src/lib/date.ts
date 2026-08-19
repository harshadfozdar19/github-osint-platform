// Shared date/time display format for the whole app: "18 August 2026" and
// "14:05" (24-hour), instead of locale-default formatting that varied by
// browser/OS - keeps every table, card, and badge consistent regardless of
// where it's rendered.

const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

type DateInput = string | number | Date | null | undefined;

/** "18 August 2026" - date only, no time. */
export function formatDate(value?: DateInput): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_FORMATTER.format(date);
}

/** "14:05" - time only (24-hour), no date. */
export function formatTime(value?: DateInput): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return TIME_FORMATTER.format(date);
}

/** "18 August 2026, 14:05" */
export function formatDateTime(value?: DateInput): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${DATE_FORMATTER.format(date)}, ${TIME_FORMATTER.format(date)}`;
}
