'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity } from 'lucide-react';
import { api, AuthResponse, setToken, setWorkspaceId } from '@/lib/api';
import { Alert, Button, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [justRegistered, setJustRegistered] = useState(false);

  useEffect(() => {
    setJustRegistered(
      new URLSearchParams(window.location.search).get('registered') === '1',
    );
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api<AuthResponse>('/auth/login', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ email, password }),
      });
      setToken(res.accessToken);
      if (res.defaultWorkspaceId) setWorkspaceId(res.defaultWorkspaceId);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white shadow-sm">
              <Activity className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-xl font-bold tracking-tight text-[var(--text)]">
              OSINT Watch
            </span>
          </Link>
          <p className="mt-3 text-sm text-[var(--muted)]">
            Sign in to monitor public GitHub threats across protected brands.
          </p>
        </div>

        {justRegistered ? (
          <Alert tone="success" className="mb-4 text-center">
            Account created — sign in to continue.
          </Alert>
        ) : null}

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-[var(--accent-border)]/50 bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-sm)]"
        >
          <Field label="Email">
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <Input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button type="submit" loading={loading} className="w-full">
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="text-center text-sm text-[var(--muted)]">
            No account?{' '}
            <Link href="/register" className="font-medium text-[var(--accent)] hover:underline">
              Register
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
