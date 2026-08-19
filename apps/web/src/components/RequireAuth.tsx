'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

type Status = 'checking' | 'authorized';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // Must start identical on server and client - SSR has no localStorage, so
  // reading it during render (e.g. in a useState initializer) makes the
  // client's first render disagree with the server-rendered HTML and trips
  // a hydration error. Only read it inside an effect, which runs after
  // hydration is already committed.
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let cancelled = false;

    const token = localStorage.getItem('accessToken');
    if (!token) {
      router.replace('/login');
      return;
    }

    // A token in localStorage was already confirmed valid by the
    // login/register call (or a previous page's background check) - trust
    // it immediately instead of blocking every route change behind a fresh
    // /auth/me round-trip, and confirm it's still valid in the background.
    setStatus('authorized');

    api('/auth/me').catch(() => {
      if (!cancelled) {
        setToken(null);
        router.replace('/login');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (status !== 'authorized') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]"
          role="status"
          aria-label="Checking your session"
        />
      </div>
    );
  }

  return <>{children}</>;
}
