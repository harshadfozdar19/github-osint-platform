'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  Boxes,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Radar,
  Search,
  Settings,
  Settings2,
  Shield,
  Users,
  X,
} from 'lucide-react';
import { setToken } from '@/lib/api';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import clsx from 'clsx';

const nav = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/scans', label: 'Scans', icon: Radar },
  { href: '/repositories', label: 'Repositories', icon: Boxes },
  { href: '/findings', label: 'Findings', icon: Shield },
  { href: '/contributors', label: 'Contributors', icon: Users },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/alerts', label: 'Alerts', icon: AlertTriangle },
];

const configNav = [
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Below `lg` the sidebar becomes an off-canvas drawer - close it
  // automatically on every navigation, otherwise it stays open covering
  // the page you just tapped through to.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[272px_1fr]">
      {/* Mobile-only top bar: the sidebar is off-canvas below `lg`, so this is
          the only persistent way to reach navigation on small screens. Same
          deep-navy surface as the sidebar itself for visual continuity. */}
      <div className="flex items-center justify-between border-b border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] px-4 py-3 lg:hidden">
        <Logo />
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          style={{ color: '#ffffff' }}
          className="rounded-lg p-2 transition-colors duration-150 hover:bg-[var(--sidebar-card-hover-bg)]"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {/* Backdrop - mobile only, dismisses the drawer on tap outside it. */}
      {mobileNavOpen ? (
        <div
          className="fixed inset-0 z-40 bg-[#0a1e3d]/50 backdrop-blur-[1px] lg:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col overflow-y-auto border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] px-4 py-6 shadow-xl transition-transform duration-200 ease-out',
          // Pinned to the viewport and independently scrollable - without
          // this, a CSS grid row stretches to match whatever the main
          // content's height is on that particular page, which drags this
          // whole column (and the Sign out button at the bottom of it) down
          // with it. On short pages that's invisible; on long ones (Findings,
          // Companies, Keywords...) Sign out ends up scrolled far below the
          // fold, effectively unreachable without scrolling the entire page.
          'lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-auto lg:translate-x-0 lg:shadow-none lg:self-start',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="mb-6 flex items-start justify-between px-1">
          <Logo />
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            style={{ color: '#ffffff' }}
            className="rounded-lg p-1 transition-colors duration-150 hover:bg-[var(--sidebar-card-hover-bg)] lg:hidden"
            aria-label="Close navigation menu"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="mb-5">
          <WorkspaceSwitcher />
        </div>

        <nav className="flex-1 space-y-1" aria-label="Main">
          {nav.map((item) => (
            <NavLink key={item.href} item={item} active={pathname.startsWith(item.href)} />
          ))}

          <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider text-white">
            Configuration
          </p>
          {configNav.map((item) => (
            <NavLink key={item.href} item={item} active={pathname.startsWith(item.href)} />
          ))}
        </nav>

        <button
          type="button"
          className="mt-6 flex w-full items-center gap-3 rounded-lg bg-[var(--sidebar-card-bg)] px-3 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[var(--sidebar-card-hover-bg)]"
          onClick={() => {
            setToken(null);
            router.push('/');
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </aside>

      {/* min-w-0 overrides the grid track's default min-content sizing -
          without it, one long unbroken string anywhere in the page can
          force the whole [272px_1fr] grid wider than the viewport instead
          of wrapping inside its own column. */}
      <main className="min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <header className="mb-7 rounded-xl border border-[var(--accent-border)]/50 bg-[var(--accent-soft)] px-5 py-4 sm:px-6 sm:py-5">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--accent-active)] sm:text-[1.75rem]">
            {title}
          </h1>
          {subtitle ? <p className="mt-1.5 text-sm text-[var(--muted)]">{subtitle}</p> : null}
        </header>
        {children}
      </main>
    </div>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-white shadow-sm">
        <Activity className="h-4 w-4" aria-hidden />
      </span>
      <span className="text-[15px] font-bold tracking-wide text-white">OSINT Watch</span>
    </div>
  );
}

function NavLink({
  item,
  active,
}: {
  item: { href: string; label: string; icon: typeof Activity };
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      style={{ color: '#ffffff' }}
      className={clsx(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150',
        active
          ? 'bg-[var(--sidebar-active-bg)] shadow-sm'
          : 'bg-[var(--sidebar-card-bg)] hover:bg-[var(--sidebar-card-hover-bg)]',
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {item.label}
    </Link>
  );
}
