/**
 * Generate brand-lookalike / attack-intent name variants for exact-ish discovery.
 * Kept small and deterministic so scan query budgets stay predictable.
 */
export function generateTypoVariants(term: string, limit = 8): string[] {
  const base = term.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (base.length < 3) return [];

  const variants = new Set<string>();

  // Intent suffixes commonly used in phishing / fake-app repos
  for (const suffix of [
    'login',
    'apk',
    'otp',
    'verify',
    'support',
    'app',
    'official',
    'wallet',
  ]) {
    variants.add(`${base}-${suffix}`);
    variants.add(`${base}${suffix}`);
  }

  // Leetspeak / common misspellings
  variants.add(base.replace(/o/g, '0').replace(/e/g, '3').replace(/a/g, '4'));
  variants.add(`${base}e`); // trailing e (phonepee)
  if (base.length > 4) {
    // drop middle char
    const mid = Math.floor(base.length / 2);
    variants.add(base.slice(0, mid) + base.slice(mid + 1));
    // adjacent transposition
    variants.add(
      base.slice(0, mid) + base[mid + 1] + base[mid] + base.slice(mid + 2),
    );
  }

  // Never include the exact brand alone (too noisy / official)
  variants.delete(base);

  return [...variants]
    .filter((v) => v.length >= 4 && v !== base)
    .slice(0, limit);
}
