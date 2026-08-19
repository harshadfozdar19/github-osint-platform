import { RepoAnalysisContext } from '../detection/rules/rule.types';

/**
 * A GitHub account is free and disposable - the same scammer routinely burns
 * one login per repo and opens a new one. What doesn't change as easily is
 * the contact/payment channel baked into the phishing kit itself (a support
 * email, a Telegram/WhatsApp link, a crypto address). Two *different* owners
 * sharing the exact same one of these is strong evidence of the same human
 * behind both, regardless of how disposable the GitHub identity was.
 */
export type FingerprintKind =
  'email' | 'telegram' | 'whatsapp' | 'discord_invite' | 'crypto_wallet';

export const FINGERPRINT_KINDS: FingerprintKind[] = [
  'email',
  'telegram',
  'whatsapp',
  'discord_invite',
  'crypto_wallet',
];

export interface ExtractedFingerprint {
  kind: FingerprintKind;
  value: string;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const TELEGRAM_RE = /(?:t\.me|telegram\.me)\/([a-z0-9_]{4,32})/gi;
const WHATSAPP_RE = /(?:wa\.me|chat\.whatsapp\.com)\/([a-z0-9]{6,20})/gi;
const DISCORD_INVITE_RE =
  /discord(?:\.gg|(?:app)?\.com\/invite)\/([a-z0-9-]{4,32})/gi;
const ETH_WALLET_RE = /\b0x[a-f0-9]{40}\b/gi;
// Heuristic - base58check (P2PKH/P2SH) and bech32 (bc1...) BTC address shapes.
// Individually noisy (could coincidentally match an unrelated hex/base58
// blob), but that risk only matters here if the *exact same* string also
// turns up under a different GitHub owner, which is what actually drives a
// match - so a loose per-repo regex is an acceptable trade for not missing
// real wallet addresses.
const BTC_WALLET_RE =
  /\b(?:bc1[a-z0-9]{25,39}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g;

// Placeholder/boilerplate addresses that show up verbatim in countless
// unrelated repos (READMEs, CI badges, LICENSE templates) - matching on
// these would link totally unrelated projects, not the same operator.
const PLACEHOLDER_EMAILS = new Set([
  'noreply@github.com',
  'support@github.com',
  'you@example.com',
  'your-email@example.com',
  'email@example.com',
  'name@example.com',
  'user@example.com',
  'admin@example.com',
  'test@example.com',
  'me@example.com',
  'hello@example.com',
]);

function isPlaceholderEmail(email: string): boolean {
  if (PLACEHOLDER_EMAILS.has(email)) return true;
  const domain = email.split('@')[1] || '';
  return (
    domain === 'example.com' ||
    domain === 'example.org' ||
    domain === 'test.com' ||
    domain === 'localhost' ||
    domain.endsWith('.example')
  );
}

/**
 * Pure extraction over README + fetched file content already gathered for
 * detection. Returns each distinct (kind, value) at most once per repo -
 * de-duping here keeps the caller's persistence step a plain upsert per
 * result instead of needing its own dedup logic.
 */
export function extractOperatorFingerprints(
  ctx: Pick<RepoAnalysisContext, 'readmeText' | 'smallFileTexts'>,
): ExtractedFingerprint[] {
  const text = [ctx.readmeText, ...ctx.smallFileTexts.map((f) => f.content)]
    .filter(Boolean)
    .join('\n');
  if (!text) return [];

  const results: ExtractedFingerprint[] = [];
  const seen = new Set<string>();
  const add = (kind: FingerprintKind, rawValue: string) => {
    // Wallet addresses are case-sensitive (base58/EIP-55 checksums) - the
    // stored value must stay copy-paste-accurate for an analyst to actually
    // look it up. Everything else (emails, handles, invite codes) is
    // conventionally case-insensitive, so normalize those for matching.
    const value = kind === 'crypto_wallet' ? rawValue : rawValue.toLowerCase();
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ kind, value });
  };

  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase();
    if (!isPlaceholderEmail(email)) add('email', email);
  }
  for (const m of text.matchAll(TELEGRAM_RE)) add('telegram', m[1]);
  for (const m of text.matchAll(WHATSAPP_RE)) add('whatsapp', m[1]);
  for (const m of text.matchAll(DISCORD_INVITE_RE)) add('discord_invite', m[1]);
  for (const m of text.matchAll(ETH_WALLET_RE)) add('crypto_wallet', m[0]);
  for (const m of text.matchAll(BTC_WALLET_RE)) add('crypto_wallet', m[0]);

  return results;
}
