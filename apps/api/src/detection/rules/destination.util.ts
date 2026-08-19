import { RepoAnalysisContext } from './rule.types';

/**
 * Third-party infrastructure so common and so clearly unrelated to
 * credential capture that flagging it would only ever be noise - fonts,
 * CDNs, analytics, well-known payment/auth SDKs. Deliberately does NOT
 * include generic hosting platforms (vercel.app, herokuapp.com, etc.) -
 * those are exactly where a scam backend would legitimately live too, so
 * excluding them would filter out the signal this check exists to find.
 */
const KNOWN_BENIGN_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
  'www.gstatic.com',
  'gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'www.google-analytics.com',
  'google-analytics.com',
  'www.googletagmanager.com',
  'googletagmanager.com',
  'sentry.io',
  'stripe.com',
  'js.stripe.com',
  'api.stripe.com',
  'checkout.stripe.com',
  'www.recaptcha.net',
  'recaptcha.net',
  'www.google.com',
  'accounts.google.com',
  'fontawesome.com',
  'use.fontawesome.com',
  'maps.googleapis.com',
  'schema.org',
  'www.w3.org',
]);

/**
 * Patterns that capture a URL from the specific contexts where captured
 * data actually gets SENT - a form's submit target, or a network call - not
 * every URL that happens to appear anywhere in the file (a comment, a link
 * to documentation, an unrelated image src). Deliberately narrow: better to
 * miss an unusual submission pattern than to flag every incidental URL in a
 * repo as a "destination".
 */
const DESTINATION_PATTERNS: RegExp[] = [
  // <form action="https://...">
  /<form[^>]*\baction\s*=\s*["']([^"']+)["']/gi,
  // fetch("https://..."), axios.post(`https://...`), $.ajax({url: "..."})
  /(?:fetch|axios(?:\.(?:get|post|put|patch|delete))?|\.open)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  // API_URL=, BASE_URL:, ENDPOINT = "..." style config assignments
  /(?:api[_-]?url|base[_-]?url|endpoint|api[_-]?base|server[_-]?url|backend[_-]?url|submit[_-]?url|webhook[_-]?url)\s*[:=]\s*["']?(https?:\/\/[^\s"'<>` ]+)/gi,
];

export interface DestinationMatch {
  hostname: string;
  url: string;
  source: string;
}

function isValidPublicHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Every known/curated domain belonging to this brand (keywords, aliases) -
 * so its own real backend is never reported as a "suspicious" destination
 * just for being a URL that isn't on the generic benign-infra allowlist.
 */
function brandOwnHostnames(ctx: RepoAnalysisContext): Set<string> {
  const candidates = [
    ...(ctx.matchedBrandAliases || []),
    ...(ctx.matchedBrandKeywords || []),
  ];
  const hostnames = new Set<string>();
  for (const c of candidates) {
    const trimmed = c.trim().toLowerCase();
    // A bare domain-shaped keyword ("zerodha.com") or a full URL keyword -
    // either way, pull out just the hostname to compare against.
    const asUrl = isValidPublicHttpUrl(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    );
    if (asUrl && /\.[a-z]{2,}$/i.test(asUrl.hostname)) {
      hostnames.add(asUrl.hostname);
    }
  }
  return hostnames;
}

const MIN_BRAND_SLUG_LENGTH = 4;

/**
 * Normalized (lowercase, alphanumeric-only) forms of the brand's own name
 * and aliases - "Zerodha" -> "zerodha". Brands are rarely configured with
 * their literal domain as an alias/keyword (aliases are name variants,
 * keywords are phishing-indicator terms), so brandOwnHostnames() above
 * misses the common case entirely: a brand's real API subdomain
 * (kite.zerodha.com) getting reported as a "suspicious"/"confirmed live
 * malicious" destination just because nobody typed "zerodha.com" into a
 * keyword field. Caught live: a real Zerodha-integrating repo had
 * kite.zerodha.com flagged as a live malicious exfiltration target.
 */
function brandNameSlugs(ctx: RepoAnalysisContext): Set<string> {
  const names = [ctx.matchedBrandName, ...(ctx.matchedBrandAliases || [])];
  const slugs = new Set<string>();
  for (const raw of names) {
    if (!raw) continue;
    const slug = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (slug.length >= MIN_BRAND_SLUG_LENGTH) slugs.add(slug);
  }
  return slugs;
}

/**
 * True if some label of the hostname (dot-separated, alphanumeric-only) is
 * exactly the brand's own name/alias - covers "zerodha.com" and any of its
 * subdomains ("kite.zerodha.com", "console.zerodha.com") without needing an
 * explicit per-brand domain allowlist. Deliberately an exact label match,
 * not a substring: "zerodha-clone.com" and "notzerodha.com" must NOT match,
 * since those are exactly the lookalike domains this detector exists to
 * catch, not exclude.
 */
function isBrandOwnedHostname(hostname: string, slugs: Set<string>): boolean {
  if (slugs.size === 0) return false;
  return hostname
    .split('.')
    .some((label) => slugs.has(label.replace(/[^a-z0-9]/g, '')));
}

// Safety cap - a handful of distinct destinations is plenty of evidence;
// beyond that it's the same handful of endpoints repeated across many files.
const MAX_DESTINATIONS = 8;

/**
 * Finds distinct external hostnames this repo's code actually sends data
 * to or fetches from - form submission targets and API call destinations,
 * not every URL that happens to appear anywhere. Excludes the brand's own
 * known domains (that's just its real backend) and well-known benign
 * third-party infrastructure (fonts, CDNs, analytics).
 */
export function extractDataDestinations(
  ctx: RepoAnalysisContext,
): DestinationMatch[] {
  const ownHostnames = brandOwnHostnames(ctx);
  const ownSlugs = brandNameSlugs(ctx);
  const seen = new Set<string>();
  const results: DestinationMatch[] = [];

  const sources: Array<{ path: string; text: string }> = [
    { path: ctx.readmePath || 'README.md', text: ctx.readmeText },
    ...ctx.smallFileTexts.map((f) => ({ path: f.path, text: f.content })),
  ];

  for (const { path, text } of sources) {
    if (results.length >= MAX_DESTINATIONS) break;
    if (!text) continue;
    for (const pattern of DESTINATION_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        if (results.length >= MAX_DESTINATIONS) break;
        const url = isValidPublicHttpUrl(match[1]);
        if (!url) continue;
        const hostname = url.hostname.toLowerCase();
        if (KNOWN_BENIGN_HOSTNAMES.has(hostname)) continue;
        if (ownHostnames.has(hostname)) continue;
        if (isBrandOwnedHostname(hostname, ownSlugs)) continue;
        if (seen.has(hostname)) continue;
        seen.add(hostname);
        results.push({ hostname, url: url.toString(), source: path });
      }
    }
  }

  return results;
}

/**
 * Deploy-config files whose mere presence signals "built to actually run
 * somewhere", not just a coding exercise sitting in a repo - a genuinely
 * weaker signal than a live URL, but still worth surfacing alongside other
 * evidence rather than silently ignored.
 */
export const DEPLOY_CONFIG_FILES = [
  'vercel.json',
  'netlify.toml',
  '_redirects',
  'now.json',
  'render.yaml',
  'railway.json',
  'railway.toml',
  'Procfile',
  'fly.toml',
  'app.yaml',
];

export function findDeployConfigFiles(filePaths: string[]): string[] {
  const found: string[] = [];
  for (const configFile of DEPLOY_CONFIG_FILES) {
    if (
      filePaths.some((p) => p === configFile || p.endsWith(`/${configFile}`))
    ) {
      found.push(configFile);
    }
  }
  return found;
}

/**
 * IPv4 ranges reserved for private/loopback/link-local use (RFC 1918 +
 * loopback + link-local + 0.0.0.0) - a destination that resolves here is
 * either internal infrastructure a public scanner has no business touching,
 * or a clumsy SSRF attempt against whatever is running this code. Checked
 * before any outbound liveness fetch, never trusted from DNS alone (see
 * checkUrlLiveness in liveness.util.ts, which re-validates every resolved
 * IP, not just the hostname).
 */
export function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this network"
  return false;
}
