import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const buttonBase =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium ' +
  'transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 ' +
  'active:scale-[0.98]';

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
};

const buttonVariantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-white shadow-sm shadow-[var(--accent)]/20 hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)]',
  secondary:
    'border border-[var(--border)] bg-[var(--bg-subtle)] text-[var(--text)] hover:bg-white hover:border-[var(--accent-border)]',
  outline:
    'border border-[var(--border)] bg-transparent text-[var(--text)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-soft)]',
  ghost: 'bg-transparent text-[var(--muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text)]',
  danger: 'bg-[var(--danger)] text-white shadow-sm shadow-[var(--danger)]/20 hover:bg-[#dc2626]',
};

/**
 * Plain string builder (no 'use client') so both server components (e.g. the
 * marketing home page) and client components (Button) can share exactly the
 * same visual language - a client-module function can't be called directly
 * from a server component in the App Router, only imported as a component.
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
) {
  return clsx(buttonBase, buttonSizes[size], buttonVariantClasses[variant], className);
}

export { buttonBase, buttonVariantClasses };
