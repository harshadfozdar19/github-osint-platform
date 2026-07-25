# GitHub OSINT Threat Intelligence Platform

## What is this, in plain English?

Imagine your company's brand — your login pages, your app, your name — showing up on GitHub in places it shouldn't. Someone cloning your login page to phish your customers. A fake version of your Android app bundled with malware. A developer accidentally uploading a file full of real passwords and API keys to a public repository.

This happens more often than you'd think, and nobody is watching for it by default. GitHub has millions of public repositories, and there's no alarm bell that rings when one of them starts impersonating your brand or leaking your secrets.

This platform is that alarm bell. You tell it which companies/brands to watch and which suspicious words to look out for (things like "login", "otp", "apk", "wallet", "secret"), and it searches public GitHub for repositories that combine your brand name with those red flags. When it finds something, it doesn't just hand you a list of links — it opens the repository, reads the code and files, and checks for real evidence: leaked AWS keys, exposed database passwords, phishing-style HTML, fake app packages, and more. Every match gets a **risk score from 0 to 100**, so you know instantly whether it's a "worth a look someday" or a "drop everything, this is bad."

> **Important:** this tool only ever *looks* at public GitHub data. It never runs, installs, or executes anything from a scanned repository — it just reads text and reports what it sees. Secrets are masked automatically before they're ever stored or displayed, so the tool never becomes a leak itself.

## What it actually does today

- **Watch your companies/brands** — add, edit, enable/disable them from the dashboard. No developer needed to add a new brand to monitor.
- **Manage your own search keywords** — the words that make a match suspicious (login, wallet, phishing, secret, apk...) are fully editable from the UI, each with a category and priority. The system also auto-promotes new keywords on its own when a confirmed high-severity finding shows a pattern worth watching for.
- **Run scans on demand** — start a scan for one specific brand, a raw custom GitHub query, or everything at once, and cap how many repositories it should check. Scans run in the background and can be cancelled or retried.
- **Search GitHub yourself** — a built-in search page lets anyone run an ad-hoc GitHub search, either by typing a query directly or by picking keywords from a list and clicking "Apply" to have a valid query built automatically — no need to learn GitHub's search syntax.
- **Show real evidence, safely** — every finding shows exactly what was found and where (file, line, matched text), so nobody has to just trust a score.
- **Alert on the important stuff** — critical and high-risk findings automatically raise an in-app alert so nothing serious gets buried in a long list.
- **Keep teams separate** — more than one team/company can use this at once. Each team ("workspace") only ever sees its own brands, keywords, scans, and findings — never anyone else's.
- **Bring your own GitHub access** — each team can plug in its own GitHub access token (encrypted, never readable again by anyone — not even by looking directly at the database) instead of sharing one token with every other team on the platform.
- **Show live progress** — while a scan runs, you watch it move through its stages in real time instead of refreshing a page and hoping.

---

## Architecture

### Simplified overview

```mermaid
flowchart LR
  Browser[Next.js Dashboard] -->|JWT REST| API[NestJS API]
  API --> Mongo[(MongoDB)]
  API --> Redis[(Redis / BullMQ)]
  Worker[Scan Workers] --> Redis
  Worker --> Mongo
  Worker --> GH[GitHub REST API]
  Worker --> Detect[Rule Detection Engine]
  Detect --> Risk[Risk Scorer 0-100]
  Risk --> Alerts[In-app Alerts]
```

### Actual architecture

The diagram above collapses a few things for a quick read. This is what's really deployed: five
independent BullMQ workers (not one generic "Scan Workers" box), the API and workers running as
one Render service rather than two separate ones, the specific managed providers in use, and the
live-progress loop that streams a running scan's status back to the browser over SSE.


<img width="576" height="805" alt="image" src="https://github.com/user-attachments/assets/ef16e797-8fd5-47aa-92a3-85e37336fd89" />


| Layer | Stack |
|-------|--------|
| Frontend | Next.js 15, React, TypeScript, Tailwind CSS |
| Backend | NestJS 11, Mongoose, JWT, Swagger, BullMQ |
| Database | MongoDB (local Docker or Atlas) |
| Queue | Redis + BullMQ (async scan workers) |

Monorepo layout:

```
apps/api   NestJS backend (/api/v1)
apps/web   Next.js dashboard
```

## Quick start (local)

### Prerequisites

- Node.js 20+
- npm 10+
- MongoDB (Docker recommended) **or** a MongoDB Atlas connection string
- Optional: a GitHub personal access token (public read) for live scans

### 1. Install dependencies

```bash
cd /path/to/assignment
npm install
```

### 2. Start MongoDB + Redis

```bash
docker compose up -d mongo redis
```

This starts MongoDB on `localhost:27017` and Redis on `localhost:6379`. Safe and reversible: `docker compose down` stops them; add `-v` only if you intentionally want to wipe local volumes. `docker compose stop` / `docker compose start` pause and resume without losing data.

Prefer MongoDB Atlas instead of local Docker? Create a free cluster, allow your IP, and paste the connection string into `apps/api/.env` as `MONGODB_URI`.

### 3. Configure environment

```bash
cp .env.example apps/api/.env
cp .env.example apps/web/.env.local
```

Edit `apps/api/.env`:

```env
NODE_ENV=development
PORT=4000
MONGODB_URI=mongodb://localhost:27017/github-osint
JWT_SECRET=replace-with-a-long-random-string-at-least-32-chars
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:3000
GITHUB_TOKEN=          # optional shared token; workspaces can also bring their own
SCAN_MAX_REPOS=1000    # cap per scan; raise toward 5000 as quota allows
SEED_ON_BOOT=true
SEED_DEMO_EMAIL=        # required if SEED_ON_BOOT=true — your choice, never commit it
SEED_DEMO_PASSWORD=     # required if SEED_ON_BOOT=true — your choice, never commit it
TOKEN_ENCRYPTION_KEY=   # required only if workspaces will set their own GitHub token
REDIS_HOST=localhost
REDIS_PORT=6379
ENABLE_QUEUE_WORKERS=true
```

Edit `apps/web/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

**Never commit real secrets.** `.env` files are gitignored — the demo credentials above and the encryption key are meant to live only in your local `.env`, never in source control.

### 4. Run it

```bash
# Terminal 1 — API (port 4000; workers run in-process when ENABLE_QUEUE_WORKERS=true)
npm run dev:api

# Terminal 2 — Web (port 3000)
npm run dev:web

# Optional production-style split (separate worker process):
# ENABLE_QUEUE_WORKERS=false npm run start:dev -w api
# npm run start:worker:dev -w api
```

- Dashboard: http://localhost:3000
- Swagger: http://localhost:4000/api/docs
- Health: http://localhost:4000/api/v1/health

### 5. Demo credentials (seeded local data only)

Seeding doesn't ship a hardcoded password — you choose it yourself via env vars, so nothing sensitive lives in the committed source. When `SEED_ON_BOOT=true` **and** both `SEED_DEMO_EMAIL` / `SEED_DEMO_PASSWORD` are set in your local `.env`, the API creates that user on boot (or after `npm run seed`). If either is missing, seeding is skipped with a warning — it never falls back to a built-in default.

Findings marked **DEMO** are synthetic and clearly labeled.

```bash
npm run seed   # seed manually instead of on boot
```

## Walking through the product, page by page

- **Dashboard** — at-a-glance view: findings by severity, recent critical hits, GitHub API quota health.
- **Companies** (brands) — add, edit, enable/disable the companies/brands you want watched. Fully manageable from the UI, nothing hardcoded.
- **Keywords** — add, edit, enable/disable the suspicious words that combine with a brand name to trigger a match (category + priority per keyword).
- **Scans** — start a scan scoped to one brand, a custom GitHub query, or everything; set a cap on how many repositories it should check; watch live progress; cancel or retry a scan.
- **Custom GitHub search** — run an ad-hoc GitHub search directly. Either type a raw GitHub query, or pick keywords from your list and click "Apply to query" to have a valid query built for you automatically.
- **Findings** — every match with full evidence: which repository, which file, which line, what was matched, the risk score and its breakdown, and a triage status you can set (acknowledged / resolved / false positive).
- **Alerts** — a focused feed of just the Critical/High findings so the important stuff never gets lost in a long list.
- **Settings** — set or remove this team's own GitHub access token, so its scans don't compete with other teams for the same shared quota. Tokens are encrypted at rest and the raw value is never shown again, only a masked "last 4 characters" confirmation.

## Asynchronous scanning (BullMQ + Redis)

Scans don't run inside the HTTP request. `POST /api/v1/scans/manual` returns **202 Accepted** with a persisted scan ID (`status: queued`) and workers pick it up from there. Workers process jobs via Redis queues:

| Queue | Responsibility |
|-------|----------------|
| `scan-orchestrator` | Validate tenant, build queries, fan out searches |
| `github-search` | GitHub repo search (rate-limit aware) |
| `repository-analysis` | Safe metadata/README/small-file fetch |
| `detection-processing` | Rule engine + risk score persistence |
| `alert-dispatch` | Critical/High in-app alerts |

A scan can optionally be scoped and capped:

```http
POST /api/v1/scans/manual
{ "mode": "incremental", "brandId": "…", "maxRepos": 200 }
```

or with a raw custom query instead of a brand:

```http
POST /api/v1/scans/manual
{ "customQuery": "kpmg filename:.env", "searchKind": "code", "maxRepos": 50 }
```

`maxRepos` is clamped server-side to the admin-configured ceiling (`SCAN_MAX_REPOS`) — a workspace can ask for fewer, never more. Every scan is started deliberately, on demand — there is no automatic background schedule.

### Worker tuning (env)

All 5 queues run as always-on workers, so their idle-maintenance chatter (stalled-job scans, empty-queue re-polling) is constant background Redis traffic independent of whether any scan is running — the dominant source of command volume on a metered/free Redis plan (e.g. Upstash's free tier). At BullMQ's defaults (30s stalled check, 5s idle re-poll) this alone costs roughly **3 million commands/month** from an app doing nothing, several times over a typical free-tier cap. Two env vars widen both:

```env
QUEUE_STALLED_INTERVAL_MS=300000   # how often each worker scans for stalled (crashed) jobs
QUEUE_DRAIN_DELAY_MS=120000        # how long a worker blocks before re-polling an empty queue
```

Neither setting delays a healthy scan: a worker's blocking wait unblocks the instant a job is actually pushed to it, regardless of how long its timeout is set to — `drainDelay` only governs how often it reissues that wait while the queue stays genuinely empty. `stalledInterval` only affects how fast a genuinely crashed worker's job is noticed and retried, which this app's traffic doesn't need to be fast. At these values idle chatter drops to roughly 150K commands/month.

Scan statuses: `queued`, `running`, `completed`, `partially_completed`, `failed`, `cancelled`.

Also available: `POST /scans/:id/cancel`, `POST /scans/:id/retry` (retry uses `failed_only` mode).

### Incremental, checkpointed scanning

Scans are **incremental by default**. Identity is always the GitHub repository **numeric ID** (names/renames are display-only).

Each repository tracks: `githubId`, `updated_at` / `pushed_at`, default branch, last processed commit SHA, last successful scan time, last ruleset version, and content ETag when available.

| Mode | Behaviour |
|------|-----------|
| `incremental` (default) | Skip content analysis when SHA + ruleset match a prior success |
| `full` | Force content analysis for every discovered repo |
| `failed_only` | Only re-analyze repos with `lastProcessingFailed` |

Rescan also happens when: content SHA changed, ruleset version changed, previous processing failed, no successful scan exists, or the client sets `forceFullScan: true`.

Checkpoints after each stage store search pagination cursors and completed/skipped/failed github IDs so interrupted jobs resume without redoing finished work. Finding upserts are fingerprint-keyed (`githubId` + rules) so resume/retry does not create duplicates; lifecycle is recorded as `new` / `unchanged` / `reopened` / `resolved`.

#### Before / after metrics (content analysis)

Illustrative 20-repo workspace where 3 repos changed since the last successful scan (same ruleset):

| Metric | Before (always full) | After (incremental) |
|--------|----------------------|---------------------|
| Content analyses | 20 | 3 |
| Skipped (unchanged) | 0 | 17 |
| Rescanned | 20 | 3 |
| Content-fetch savings | — | ~85% |

HEAD SHA / metadata checks still run for accurate skip decisions; heavy README/file fetches are what get skipped.

### Real-time progress (SSE)

`GET /api/v1/scans/:id/events` streams authenticated progress events (JWT + `X-Workspace-Id`). Workers publish via Redis Pub/Sub so multiple API instances can fan out. Latest progress is persisted on the scan document for refresh/reconnect (`afterSeq` sequencing). If the browser's live stream can't connect, the dashboard quietly falls back to polling the same progress instead — you never lose visibility into a running scan.

Polling fallback: `GET /api/v1/scans/:id/progress?afterSeq=N`.

## GitHub rate-limit management

All GitHub traffic goes through a single managed client (`GitHubHttpClient`). No worker or service may call `api.github.com` directly.

| Concern | Behaviour |
|---------|-----------|
| Primary quota | Tracks `X-RateLimit-*` headers (limit, remaining, used, reset, resource) in Redis |
| Secondary / abuse | Honours `Retry-After`; pauses shared workers |
| Retries | Bounded exponential backoff + jitter; never retries 401/403 permission/422 validation |
| Low quota | When remaining ≤ `GITHUB_RATE_LIMIT_PAUSE_AT`, jobs pause and auto-resume after reset |
| Fairness | Per-workspace daily budget + concurrency; global concurrency cap |
| Per-workspace tokens | A workspace using its own GitHub token gets fully separate quota tracking — its usage never competes with, or is blocked by, the shared token's state |
| Conditional GETs | ETag / `If-None-Match` for content endpoints |
| Observability | Structured logs (no tokens) + counters; `GET /api/v1/github/rate-limit` |
| Redis command volume | Every call re-checks pause/quota state in Redis before proceeding; these reads are cached in-process for `GITHUB_RATE_LIMIT_CACHE_MS` (default 1s) so a burst of calls collapses into one Redis round trip instead of one per call. Writes are batched the same way: request-count metrics accumulate in memory and flush periodically instead of one write per call, and rate-limit snapshot writes are throttled to the same interval — except when remaining quota nears the pause threshold, which always flushes immediately so pause detection is never delayed |

The **GitHub API quota** panel on the dashboard shows this live: `CORE` is GitHub's general REST quota (repo/content fetches, 5,000/hr for an authenticated token), `SEARCH` is the separate, stricter quota for `/search/*` calls, `WORKSPACE BUDGET` only applies to workspaces still on the shared token (a fairness cap so one team can't starve another's share of the *shared* token), and `PAUSED SCANS` shows how many scans are currently waiting out a rate-limit pause.

### Administrator thresholds (env)

```env
GITHUB_RATE_LIMIT_LOW=20              # dashboard warning
GITHUB_RATE_LIMIT_PAUSE_AT=5          # pause workers
GITHUB_WORKSPACE_DAILY_BUDGET=5000    # per-tenant daily requests (shared-token workspaces only)
GITHUB_WORKSPACE_MAX_CONCURRENCY=2    # per-tenant in-flight
GITHUB_GLOBAL_MAX_CONCURRENCY=10      # across all tenants
GITHUB_RETRY_ATTEMPTS=3
GITHUB_MAX_INLINE_WAIT_MS=15000       # wait inline; longer waits delay BullMQ jobs
```

## Per-workspace GitHub tokens (Settings page)

Any workspace can set its own GitHub personal access token from the Settings page instead of relying on the shared instance-level token. The security model:

- Tokens are encrypted at rest with **AES-256-GCM** before being written to the database — the raw token is never stored in plaintext.
- The encryption key (`TOKEN_ENCRYPTION_KEY`) lives only in server environment variables, never in the database itself — so even someone with direct, full read access to the database cannot decrypt a stored token without also having the server's environment secret.
- The API only ever returns a masked status (`configured: true/false`, last 4 characters) — the full token is never sent back to the browser after it's set, not even to the person who set it.

## Multi-tenancy

Tenant-scoped resources (brands, keywords, findings, scans, alerts, repositories) require the `X-Workspace-Id` header. Membership is verified on every request — the header alone is never trusted.

Every workspace has exactly one member: its **owner**, who is whoever created it. New registrations automatically get their own personal workspace as its owner. There's no invite/member-management flow and no secondary role — a workspace is a private space for one account's brands, keywords, scans, and findings, fully isolated from every other workspace on the platform.

## Without a GitHub token

The API boots and the dashboard works without `GITHUB_TOKEN`. Queued scans complete with a message that live GitHub calls were skipped. Add a classic PAT with minimal public read access (either the shared env var or a per-workspace token in Settings) to enable live searches.

## API overview

All routes are prefixed with `/api/v1` and documented in Swagger.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | No | Register (creates a personal workspace as owner) |
| POST | `/auth/login` | No | Login |
| GET | `/auth/me` | Yes | Current user |
| GET | `/dashboard/summary` | Yes | Overview stats |
| GET | `/findings` | Yes | Filtered findings (incl. `status`) |
| GET | `/findings/:id` | Yes | Finding detail |
| PATCH | `/findings/:id/status` | Yes | Triage status + note |
| GET | `/scans` | Yes | Scan history |
| POST | `/scans/manual` | Yes | Enqueue a scan (202); body `{ mode?, forceFullScan?, brandId?, customQuery?, searchKind?, maxRepos? }` |
| GET | `/scans/search` | Yes | Ad-hoc GitHub repo/code search through the managed client |
| GET | `/scans/:id` | Yes | Scan job detail |
| GET | `/scans/:id/progress` | Yes | Poll latest progress |
| GET | `/scans/:id/events` | Yes | SSE progress stream |
| POST | `/scans/:id/cancel` | Yes | Cancel queued/running scan |
| POST | `/scans/:id/retry` | Yes | Retry failed/partial scan (202) |
| GET | `/brands` (alias: `/companies`) | Yes | Monitored companies/brands |
| POST | `/brands` | Yes | Add a company/brand |
| PATCH | `/brands/:id` | Yes | Edit / enable / disable a brand |
| DELETE | `/brands/:id` | Yes | Remove a brand |
| GET | `/keywords` | Yes | Monitored keywords |
| POST | `/keywords` | Yes | Add a keyword |
| PATCH | `/keywords/:id` | Yes | Edit / enable / disable a keyword |
| DELETE | `/keywords/:id` | Yes | Remove a keyword |
| GET | `/alerts` | Yes | In-app alerts |
| PATCH | `/alerts/:id/read` | Yes | Mark alert read |
| GET | `/github/rate-limit` | Yes | GitHub quota / budget / pause status |
| GET | `/workspaces` | Yes | List workspaces you belong to |
| POST | `/workspaces` | Yes | Create a workspace (you become its owner) |
| GET/PATCH/DELETE | `/workspaces/:id/github-token` | Yes | Manage this workspace's own GitHub token |
| GET | `/health` | No | Health check |

## Detection & risk scoring

Modular rules live under `apps/api/src/detection/rules/` and are independent of the GitHub client:

- Exposed secrets (AWS, GitHub PAT, MongoDB/Postgres/MySQL URIs, Firebase, Stripe, Slack, OpenAI, Anthropic, Discord, Twilio, SendGrid, JWT, SSH, generic tokens + high-entropy assignments)
- Brand impersonation
- Phishing indicators
- Fake APK / Android
- Malware indicators
- Obfuscated commands
- Low-reputation / newly created brand repos

Discovery is multi-channel (not keyword-only): query families (apk / phishing / impersonation), typo-squat name checks, brand-agnostic filename/secret code search, then owner fan-out + fork walking from Critical/High hits. Repository analysis uses recursive git trees and prioritizes `.env` / credential paths.

**Clone-based scanning** (`ENABLE_CLONE_SCAN`, **on by default**) shallow-clones eligible repos over git's own transport instead of fetching files one-by-one through the REST API, and scans the full working tree locally (skipping `node_modules`, `dist`, `vendor`, and similar directories). Two independent wins: full-repo coverage instead of a bounded priority-file list, and it isn't subject to the REST rate limit *or* the Redis-backed rate-limit/concurrency bookkeeping every REST call goes through — which is what actually keeps a large scan (hundreds of repos) from burning through a metered Redis plan's monthly command budget. It fails closed: any problem (git unavailable, clone timeout, repo over `CLONE_SCAN_MAX_REPO_SIZE_KB`) just falls back to the REST-based fetch (`SCAN_MAX_FILES_PER_REPO`, default 12 files/repo) with no other change in behavior, so it's safe to leave on, and can be disabled with `ENABLE_CLONE_SCAN=false` at any time.

Two feedback mechanisms close the loop from what's actually found back into future scans:
- **Keyword auto-promotion** (`AUTO_PROMOTE_KEYWORDS`, on by default): a Critical/High finding checks the repo's name/description/topics against the curated keyword universe and auto-enables any matching term the workspace hasn't turned on yet, so future query generation organically expands from confirmed threats instead of only from queries picked in advance.
- **Git history scan** (`ENABLE_GIT_HISTORY_SCAN`, off by default — costs extra GitHub requests): for repos that already matched a monitored brand, scans recent commit diffs (not just current HEAD) for secrets that were committed and later deleted — a live-HEAD-only scan never sees those. Findings from history are tagged with a `history/<sha>/<path>` file so they're clearly distinguishable from live evidence.

Risk score **0–100** with stored breakdown:

| Band | Severity |
|------|----------|
| 85–100 | Critical |
| 65–84 | High |
| 40–64 | Medium |
| 0–39 | Low |

Critical and High findings create **in-app alerts**. Findings can be triaged (`open` / `acknowledged` / `false_positive` / `resolved`) with notes. `resolved` findings **reopen** automatically if the same fingerprint is seen again (it was a real issue that came back); `false_positive` findings do **not** — that's a human verdict that the pattern isn't a threat, and re-flagging it on every rescan would just be triage noise.

## Scripts

```bash
npm run dev:api      # Nest watch mode
npm run dev:web      # Next.js dev server
npm run build        # Build api + web
npm run lint         # Lint both apps
npm run typecheck    # Typecheck both apps
npm run test         # Run tests
npm run seed         # Seed demo data (requires SEED_DEMO_EMAIL / SEED_DEMO_PASSWORD)
npm run migrate:workspaces   # One-off: backfill pre-existing users/records into workspaces
```

## Testing

```bash
npm run test:api
```

API unit tests cover authentication flows, multi-tenancy/membership enforcement, detection rules, risk scoring, secret redaction, per-workspace token encryption, GitHub rate-limit scoping, and fingerprint stability. GitHub calls are never required for tests.

## Security notes

- Helmet, CORS allowlist, global validation pipes, throttling
- Passwords hashed with bcrypt (12 rounds)
- JWT bearer auth on protected routes
- Per-workspace GitHub tokens encrypted at rest with AES-256-GCM; the decryption key never lives in the database, so a database leak alone can't expose a token
- Secret redaction utility used before persistence/logs/UI
- Outbound GitHub requests use a fixed `api.github.com` base URL with owner/repo/path validation (SSRF-aware)
- Conservative GitHub usage (`SCAN_MAX_REPOS`, small pages, pacing delays)
- No execution of repository content; only small text files (<50KB) are fetched
- Every tenant-scoped request re-verifies workspace membership server-side — a workspace ID in a request header is never trusted on its own

## Known limitations

- A workspace has exactly one member (its owner) by design — there's no invite/team flow, so it can't be shared with teammates today.
- Scans are entirely on-demand — there is no automatic/background scheduling; someone (or an external scheduler hitting the API) has to start each scan.

## Assignment PDF

See `GitHub_OSINT_Assignment.pdf` in the repo root.

## License

UNLICENSED — candidate assignment deliverable.
