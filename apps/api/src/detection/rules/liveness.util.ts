import { lookup } from 'dns/promises';
import { isPrivateOrLoopbackIPv4 } from './destination.util';

export interface LivenessResult {
  url: string;
  live: boolean;
  statusCode?: number;
}

/**
 * Resolves a hostname and confirms it's a genuinely public IPv4 address -
 * the SSRF guard for checkUrlLiveness below. A destination extracted from a
 * suspect repo's own code is attacker-influenced input; without this, a
 * crafted hostname (or one that simply happens to be internal
 * infrastructure) could turn a read-only "is this live" check into a probe
 * of whatever network this backend itself runs on. Resolution happens once,
 * immediately before the fetch, not cached or trusted from an earlier call.
 */
async function resolvesToPublicIPv4(hostname: string): Promise<boolean> {
  if (hostname === 'localhost') return false;
  try {
    const { address } = await lookup(hostname, { family: 4 });
    return !isPrivateOrLoopbackIPv4(address);
  } catch {
    return false;
  }
}

/**
 * Read-only liveness check for a URL discovered inside a suspect repo's own
 * code (see extractDataDestinations) - answers "is this actually reachable
 * right now", the difference between source code sitting unused in a repo
 * and an active operation. Deliberately minimal: a single request, status
 * code only, response body never read or stored, no credentials or cookies
 * ever sent. Fails closed (returns null) on any error, invalid URL, or a
 * hostname that doesn't resolve to a public address - never throws into the
 * caller, since a dead/unreachable/malformed URL is an entirely expected,
 * non-exceptional outcome here.
 */
export async function checkUrlLiveness(
  rawUrl: string,
  timeoutMs = 5000,
): Promise<LivenessResult | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!(await resolvesToPublicIPv4(url.hostname))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OSINTWatch/1.0)' },
    });
    // Drain and discard the body without holding it in memory - this is a
    // liveness check, not a content fetch; nothing about the response is
    // ever read, stored, or passed further than the status code itself.
    await res.body?.cancel().catch(() => undefined);
    return {
      url: url.toString(),
      live: res.status < 500,
      statusCode: res.status,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// GitHub Pages status is checked via GitHubService.getRepositoryPagesInfo
// instead of a raw fetch here - it's a first-party GitHub API call, so it
// belongs on the same rate-limited/token-aware http client every other
// GitHub call in this app already goes through, not a one-off bypass of it.
