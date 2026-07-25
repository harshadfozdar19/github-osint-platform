'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Radar,
  Search,
  Settings,
  Settings2,
  Shield,
} from 'lucide-react';
import { setToken } from '@/lib/api';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import clsx from 'clsx';

const nav = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/findings', label: 'Findings', icon: Shield },
  { href: '/scans', label: 'Scans', icon: Radar },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/alerts', label: 'Alerts', icon: AlertTriangle },
  { href: '/brands', label: 'Companies', icon: Settings2 },
  { href: '/keywords', label: 'Keywords', icon: KeyRound },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="min-h-screen grid lg:grid-cols-[240px_1fr]">
      <aside className="border-r border-[var(--border)] bg-[rgba(16,11,28,0.85)] backdrop-blur px-4 py-6">
        <div className="mb-8 px-2">
          <div className="flex items-center gap-2 text-[var(--accent)]">
            <Activity className="h-5 w-5" aria-hidden />
            <span className="font-semibold tracking-wide text-sm uppercase">OSINT Watch</span>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)] leading-relaxed">
            GitHub threat intelligence for brand & credential exposure
          </p>
        </div>
        <div className="mb-6">
          <WorkspaceSwitcher />
        </div>
        <nav className="space-y-1" aria-label="Main">
          {nav.map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition',
                  active
                    ? 'bg-[var(--bg-panel)] text-[var(--accent)]'
                    : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--bg-elevated)]',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <button
          type="button"
          className="mt-10 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--bg-elevated)]"
          onClick={() => {
            setToken(null);
            router.push('/');
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </aside>

      <main className="px-4 py-6 sm:px-8">
        <header className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-[var(--muted)]">{subtitle}</p> : null}
        </header>
        {children}
      </main>
    </div>
  );
}
