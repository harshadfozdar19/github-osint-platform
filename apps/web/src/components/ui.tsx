'use client';

import {
  ButtonHTMLAttributes,
  FormEvent,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  useEffect,
  useState,
} from 'react';
import { AlertTriangle, ChevronDown, Inbox, Loader2, X } from 'lucide-react';
import clsx from 'clsx';
import { severityColor } from '@/lib/api';
import {
  buttonBase,
  buttonClasses,
  buttonVariantClasses,
  ButtonSize,
  ButtonVariant,
} from '@/lib/button-styles';

export type { ButtonSize, ButtonVariant };
export { buttonClasses };

/* ---------------------------------------------------------------------- */
/* Button                                                                  */
/* ---------------------------------------------------------------------- */

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/** Square, icon-only button (e.g. close/menu triggers) sharing the same interaction language. */
export function IconButton({
  variant = 'ghost',
  className,
  children,
  label,
  ...rest
}: {
  variant?: ButtonVariant;
  label: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      aria-label={label}
      className={clsx(
        buttonBase,
        'h-9 w-9 p-0',
        buttonVariantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/* Form controls                                                          */
/* ---------------------------------------------------------------------- */

const fieldBase =
  'w-full rounded-lg border bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)] ' +
  'placeholder:text-[var(--muted)] outline-none transition-colors duration-150 ' +
  'focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)] ' +
  'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-[var(--bg-subtle)]';

export function Input({
  className,
  invalid,
  ...rest
}: { invalid?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        fieldBase,
        invalid ? 'border-[var(--danger)]' : 'border-[var(--border)]',
        className,
      )}
      {...rest}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={clsx(fieldBase, 'appearance-none border-[var(--border)] pr-9', className)}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
        aria-hidden
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={clsx('block text-sm', className)}>
      <span className="mb-1.5 block font-medium text-[var(--muted)]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-[var(--muted)]">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={clsx(
        'h-4 w-4 shrink-0 rounded border-[var(--border)] text-[var(--accent)] ' +
          'accent-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)]',
        className,
      )}
      {...rest}
    />
  );
}

/** Two-way (or N-way) pill switcher - e.g. "Any date / Filter by dates". */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  disabled,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  size?: ButtonSize;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={clsx(
              'rounded-lg font-medium transition-colors duration-150 disabled:opacity-50',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              active
                ? 'bg-[var(--accent)] text-white shadow-sm'
                : 'text-[var(--muted)] hover:text-[var(--text)]',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** On/off switch, e.g. per-keyword pause/resume. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-40"
      style={{ background: checked ? 'var(--accent)' : 'var(--border)' }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-150"
        style={{ left: checked ? '18px' : '2px' }}
      />
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/* Surfaces                                                                */
/* ---------------------------------------------------------------------- */

export function Card({
  className,
  hoverable,
  children,
  as: Tag = 'div',
  ...rest
}: {
  hoverable?: boolean;
  /** Render as a different element (e.g. "li" inside a <ul>) while keeping identical styling. */
  as?: 'div' | 'li';
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={clsx(
        'rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)]',
        hoverable &&
          'transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--accent-border)] hover:shadow-[var(--shadow-md)]',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
        {subtitle ? <p className="mt-1 text-xs text-[var(--muted)]">{subtitle}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Modal                                                                   */
/* ---------------------------------------------------------------------- */

/** Simple centered overlay dialog - closes on Escape or backdrop click. No focus trap; fine for short-lived pickers/confirmations, not for long forms. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-md)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] p-4">
          <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Badges / alerts                                                        */
/* ---------------------------------------------------------------------- */

export type BadgeTone = 'accent' | 'danger' | 'warning' | 'muted' | 'success';

const badgeToneVars: Record<BadgeTone, string> = {
  accent: 'var(--accent)',
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  muted: 'var(--muted)',
  success: 'var(--low)',
};

// Literal pre-mixed tokens, not the text color diluted with a hex-alpha
// suffix at render time (`${color}1a` etc.) - that produces an invalid CSS
// color value ("var(--danger)1a" isn't a real token), which browsers
// silently drop, leaving the background fully transparent. See the comment
// on --danger-soft in globals.css for the full explanation.
const badgeToneBg: Record<BadgeTone, string> = {
  accent: 'var(--accent-soft)',
  danger: 'var(--danger-soft)',
  warning: 'var(--warning-soft)',
  muted: 'var(--bg-subtle)',
  success: 'var(--low-soft)',
};

const badgeToneBorder: Record<BadgeTone, string> = {
  accent: 'var(--accent-border)',
  danger: 'var(--danger-border-soft)',
  warning: 'var(--warning-border-soft)',
  muted: 'var(--border)',
  success: 'var(--low-border-soft)',
};

export function Badge({
  tone = 'muted',
  children,
  className,
  dot,
  wrap,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /** Prefixes a small pulsing dot in the badge's own tone color - e.g. to mark a status as live/active. */
  dot?: boolean;
  /** Allow long content (a free-text keyword, not a short fixed label) to
   * wrap and shrink to the available width instead of forcing the badge -
   * and everything around it - to overflow. Off by default since most
   * badges hold short, known-shape text (statuses, counts) where a forced
   * single line is exactly what you want. */
  wrap?: boolean;
}) {
  const color = badgeToneVars[tone];
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
        wrap ? 'whitespace-normal break-words' : 'whitespace-nowrap',
        className,
      )}
      style={{
        color,
        background: badgeToneBg[tone],
        border: `1px solid ${badgeToneBorder[tone]}`,
      }}
    >
      {dot ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: color }} />
      ) : null}
      {children}
    </span>
  );
}

// Same literal-token requirement as badgeToneBg/badgeToneBorder above -
// diluting severityColor()'s var() output with a hex-alpha suffix produces
// an invalid color value that browsers drop, so these severity badges (the
// most-visible colored element in a threat-intel app) were always rendering
// with a fully transparent background.
const severitySoftBg: Record<string, string> = {
  critical: 'var(--critical-soft)',
  high: 'var(--high-soft)',
  medium: 'var(--medium-soft)',
  low: 'var(--low-soft)',
};

const severitySoftBorder: Record<string, string> = {
  critical: 'var(--critical-border-soft)',
  high: 'var(--high-border-soft)',
  medium: 'var(--medium-border-soft)',
  low: 'var(--low-border-soft)',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className="inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-semibold uppercase tracking-wide"
      style={{
        color: severityColor(severity),
        background: severitySoftBg[severity] ?? severitySoftBg.low,
        border: `1px solid ${severitySoftBorder[severity] ?? severitySoftBorder.low}`,
      }}
    >
      {severity}
    </span>
  );
}

export type AlertTone = 'info' | 'warning' | 'danger' | 'success';

// Literal pre-mixed tokens, not a hex-alpha suffix appended to a var() at
// render time - see the --danger-soft comment in globals.css for why that
// silently renders fully transparent instead of tinted.
const alertToneStyles: Record<AlertTone, { color: string; border: string; bg: string }> = {
  info: { color: 'var(--accent-active)', border: 'var(--accent-border)', bg: 'var(--accent-soft)' },
  warning: { color: 'var(--warning)', border: 'var(--warning-border-soft)', bg: 'var(--warning-soft)' },
  danger: { color: 'var(--danger)', border: 'var(--danger-border-soft)', bg: 'var(--danger-soft)' },
  success: { color: 'var(--low)', border: 'var(--low-border-soft)', bg: 'var(--low-soft)' },
};

export function Alert({
  tone = 'info',
  children,
  className,
}: {
  tone?: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  const s = alertToneStyles[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={clsx('rounded-lg border px-3.5 py-2.5 text-sm', className)}
      style={{
        color: s.color,
        borderColor: s.border,
        background: s.bg,
      }}
    >
      {children}
    </div>
  );
}

export function DemoBanner() {
  return (
    <Alert tone="warning" className="mb-4">
      Demo data present — findings marked DEMO are seeded for local demonstration and are not live
      GitHub results.
    </Alert>
  );
}

/* ---------------------------------------------------------------------- */
/* Stat / empty / loading                                                 */
/* ---------------------------------------------------------------------- */

export function StatCard({
  label,
  value,
  hint,
  /** CSS color for the value text - ties the number's emphasis to what it
   * actually means (e.g. var(--critical) for a critical-findings count)
   * instead of every stat looking identically "loud". Defaults to the
   * normal text color for stats with no inherent severity/urgency. */
  valueColor,
}: {
  label: string;
  value: string | number;
  hint?: string;
  valueColor?: string;
}) {
  return (
    <Card className="border-[var(--accent-border)]/50 bg-[var(--accent-soft)] p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">{label}</p>
      <p
        className="mt-2 text-3xl font-bold tracking-tight font-[family-name:var(--font-mono)]"
        style={{ color: valueColor ?? 'var(--accent-active)' }}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
    </Card>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: typeof Inbox;
}) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-subtle)]/40 px-6 py-12 text-center">
      <div className="mx-auto mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-[var(--text)]">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--muted)]">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/[0.12] px-4 py-3.5 text-sm text-[var(--danger)]">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1">
        <p>{message}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="mt-1.5 font-medium hover:underline">
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] p-8 text-sm text-[var(--muted)] shadow-[var(--shadow-sm)]"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" aria-hidden />
      {label}
    </div>
  );
}

/** Skeleton loader that echoes the shape of a data table - keeps layout stable while the real rows stream in. */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)]"
      role="status"
      aria-label="Loading table"
    >
      <div className="border-b border-[var(--border)] bg-[var(--bg-subtle)] p-3">
        <div className="h-3 w-32 animate-pulse rounded bg-[var(--border)]" />
      </div>
      <div className="divide-y divide-[var(--border)]">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 p-4">
            {Array.from({ length: cols }).map((__, c) => (
              <div
                key={c}
                className="h-3 flex-1 animate-pulse rounded bg-[var(--border)]"
                style={{ animationDelay: `${(r * cols + c) * 40}ms`, maxWidth: c === 0 ? '40%' : '100%' }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardSkeleton({ count = 1 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-sm)]"
          role="status"
          aria-label="Loading"
        >
          <div className="h-3 w-1/3 animate-pulse rounded bg-[var(--border)]" />
          <div className="mt-3 h-2.5 w-2/3 animate-pulse rounded bg-[var(--border)]" />
          <div className="mt-2 h-2.5 w-1/2 animate-pulse rounded bg-[var(--border)]" />
        </div>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------------- */
/* Pagination                                                             */
/* ---------------------------------------------------------------------- */

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
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </Button>
      <span className="text-sm text-[var(--muted)]">
        Page {page} of {totalPages}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </Button>
      <form onSubmit={onJump} className="flex items-center gap-2">
        <label htmlFor="page-jump" className="text-sm text-[var(--muted)]">
          Go to page
        </label>
        <Input
          id="page-jump"
          type="number"
          min={1}
          max={totalPages}
          value={jumpTo}
          onChange={(e) => setJumpTo(e.target.value)}
          className="w-16 py-1.5"
        />
        <Button type="submit" variant="outline" size="sm">
          Go
        </Button>
      </form>
    </div>
  );
}
