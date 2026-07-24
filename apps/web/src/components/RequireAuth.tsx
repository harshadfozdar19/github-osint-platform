'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

type Status = 'checking' | 'authorized';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let cancelled = false;

    async function verify() {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        router.replace('/login');
        return;
      }
      try {
        // A token being present isn't enough - confirm the server still
        // considers it valid (not expired/tampered) before rendering
        // anything protected.
        await api('/auth/me');
        if (!cancelled) setStatus('authorized');
      } catch {
        if (!cancelled) {
          setToken(null);
          router.replace('/login');
        }
      }
    }

    void verify();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Render nothing until the token is confirmed valid - avoids ever
  // flashing protected content for a missing/expired/tampered token.
  if (status !== 'authorized') return null;

  return <>{children}</>;
}
