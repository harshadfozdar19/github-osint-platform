import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  KeyRound,
  Lock,
  Mail,
  Radar,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
} from 'lucide-react';

// lucide-react doesn't ship brand logos, so these two are hand-rolled.
function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.09 3.29 9.4 7.86 10.93.57.1.78-.25.78-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.28-1.7-1.28-1.7-1.04-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.2.66.79.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

function LinkedinIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.03-1.85-3.03-1.85 0-2.14 1.45-2.14 2.94v5.66H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45Z" />
    </svg>
  );
}

const GITHUB_URL = 'https://github.com/harshadfozdar19/github-osint-platform';
const LINKEDIN_URL = 'https://www.linkedin.com/in/harshad-fozdar-85966a24a/';
const EMAIL = 'harshad622004fozdar@gmail.com';

const features = [
  {
    icon: Shield,
    title: 'Exposed Secret Detection',
    body: 'AWS keys, GitHub PATs, JWTs, MongoDB/Postgres URIs, Firebase, Slack/Discord tokens, private keys, and high-entropy assignments.',
  },
  {
    icon: Radar,
    title: 'Automated, Resumable Scans',
    body: 'Incremental, checkpointed scanning across thousands of repos - only re-analyzes what actually changed.',
  },
  {
    icon: AlertTriangle,
    title: 'Brand Impersonation & Phishing',
    body: 'Typo-squats, fake APKs, cloned login pages, and phishing-kit indicators tied to the brands you monitor.',
  },
  {
    icon: Search,
    title: 'Ad-hoc GitHub Search',
    body: 'A keyword picker builds valid GitHub queries for you - no search syntax required.',
  },
  {
    icon: KeyRound,
    title: 'Encrypted Workspace Tokens',
    body: 'Bring your own GitHub token, encrypted at rest with AES-256-GCM. Never stored in plaintext, never shown again.',
  },
  {
    icon: Settings2,
    title: 'Isolated Multi-Tenant Workspaces',
    body: 'Every workspace is a fully separate space for brands, keywords, scans, and findings.',
  },
];

const severities = [
  { label: 'Critical', color: 'var(--critical)', range: '85–100' },
  { label: 'High', color: 'var(--high)', range: '65–84' },
  { label: 'Medium', color: 'var(--medium)', range: '40–64' },
  { label: 'Low', color: 'var(--low)', range: '0–39' },
];

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* Ambient glow orbs, matching the radial gradients used site-wide */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -left-40 h-[32rem] w-[32rem] rounded-full opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--accent), transparent 70%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-20 right-[-10rem] h-[28rem] w-[28rem] rounded-full opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #facc15, transparent 70%)' }}
      />

      <div className="relative mx-auto max-w-6xl px-6">
        {/* Header */}
        <header className="flex items-center justify-between py-6">
          <div className="inline-flex items-center gap-2 text-[var(--accent)]">
            <Activity className="h-6 w-6" aria-hidden />
            <span className="text-lg font-semibold tracking-wide text-[var(--text)]">
              OSINT Watch
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-[var(--accent-dim)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
            >
              Get Started
            </Link>
          </div>
        </header>

        {/* Hero */}
        <section className="py-20 text-center sm:py-28">
          <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)]/70 px-4 py-1.5 text-xs text-[var(--muted)]">
            <Lock className="h-3.5 w-3.5" aria-hidden />
            Defensive OSINT · No code execution · Secrets auto-redacted
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
            Catch{' '}
            <span className="bg-gradient-to-r from-[var(--accent)] to-[#facc15] bg-clip-text text-transparent">
              leaked secrets, fake apps, and phishing kits
            </span>{' '}
            on GitHub before they catch you
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-[var(--muted)] sm:text-lg">
            A GitHub threat-intelligence platform that watches public repositories for
            exposed credentials, brand impersonation, and malicious clones - then scores
            every finding from 0 to 100 so you know instantly what actually matters.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/register"
              className="rounded-md bg-[var(--accent-dim)] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-[var(--accent-dim)]/30 transition-all hover:scale-[1.03] hover:bg-[var(--accent-hover)]"
            >
              Create Free Account
            </Link>
            <Link
              href="/login"
              className="rounded-md border border-[var(--border)] px-6 py-3 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--bg-elevated)]"
            >
              Sign In
            </Link>
          </div>
        </section>

        {/* Feature grid */}
        <section className="py-12">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="group rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]/60 p-6 transition-all hover:border-[var(--accent)]/50 hover:bg-[var(--bg-elevated)]"
              >
                <div className="mb-4 inline-flex rounded-lg bg-[var(--accent-dim)]/20 p-2.5 text-[var(--accent)] transition-colors group-hover:bg-[var(--accent-dim)]/30">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <h3 className="mb-1.5 font-semibold text-[var(--text)]">{title}</h3>
                <p className="text-sm leading-relaxed text-[var(--muted)]">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Risk scoring strip */}
        <section className="py-12">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]/60 p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-[var(--accent)]" aria-hidden />
              <h2 className="font-semibold text-[var(--text)]">
                Every finding gets a risk score, not just a list of links
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {severities.map((s) => (
                <div
                  key={s.label}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg)]/60 p-4 text-center"
                >
                  <div
                    className="mx-auto mb-2 h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <p className="text-sm font-semibold text-[var(--text)]">{s.label}</p>
                  <p className="text-xs text-[var(--muted)]">{s.range}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Footer / connect */}
        <footer className="mt-8 border-t border-[var(--border)] py-10">
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-[var(--muted)]">
              Built by <span className="text-[var(--text)]">Harshad Fozdar</span> - let&apos;s connect
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--accent)]"
              >
                <GithubIcon className="h-4 w-4" />
                GitHub Repo
              </a>
              <a
                href={LINKEDIN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--accent)]"
              >
                <LinkedinIcon className="h-4 w-4" />
                LinkedIn
              </a>
              <a
                href={`mailto:${EMAIL}`}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--accent)]"
              >
                <Mail className="h-4 w-4" aria-hidden />
                {EMAIL}
              </a>
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              This tool only analyzes publicly available GitHub data. It never executes,
              installs, or runs code from scanned repositories.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
