'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity } from 'lucide-react';
import { api, AuthResponse, setToken, setWorkspaceId } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 text-[var(--accent)]">
            <Activity className="h-6 w-6" aria-hidden />
            <span className="text-xl font-semibold tracking-wide">OSINT Watch</span>
          </div>
          <p className="mt-3 text-sm text-[var(--muted)]">
            Sign in to monitor public GitHub threats across protected brands.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]/90 p-6 space-y-4"
        >
          <div>
            <label htmlFor="email" className="block text-sm mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]"
            />
          </div>
          {error ? (
            <p className="text-sm text-[var(--danger)]" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-[var(--accent-dim)] hover:bg-[var(--accent-hover)] px-3 py-2 font-medium text-white disabled:opacity-60"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="text-center text-sm text-[var(--muted)]">
            No account?{' '}
            <Link href="/register" className="text-[var(--accent)] hover:underline">
              Register
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
