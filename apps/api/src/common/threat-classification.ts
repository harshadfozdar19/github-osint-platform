import { ThreatCategory } from './enums';

/**
 * Two genuinely different problems get lumped into one score today: someone
 * accidentally leaving a real credential in their code (an operational risk
 * you fix by rotating the key) versus someone deliberately building a fake
 * login page or app to attack a brand (adversarial intent, a different
 * remediation path entirely - report/takedown, not "rotate a secret").
 * `categories` alone doesn't say which situation you're looking at, since a
 * finding can carry categories from either or both. This derives an
 * explicit classification instead of leaving that inference to the reader.
 */
export type ThreatClass = 'credential_exposure' | 'malicious_intent' | 'other';

export const CREDENTIAL_EXPOSURE_CATEGORIES: ThreatCategory[] = [
  ThreatCategory.EXPOSED_SECRET,
  ThreatCategory.CREDENTIAL_REUSE,
];

export const MALICIOUS_INTENT_CATEGORIES: ThreatCategory[] = [
  ThreatCategory.BRAND_IMPERSONATION,
  ThreatCategory.PHISHING,
  ThreatCategory.FAKE_APK,
  ThreatCategory.MALWARE,
  // Verbatim wording/file copies are deliberate reuse of the brand's own
  // product, not an accidental operational mistake - same bucket as
  // impersonation/phishing, unlike CREDENTIAL_REUSE (which pairs with
  // EXPOSED_SECRET as an operational-risk finding, not an intent signal).
  ThreatCategory.CONTENT_REUSE,
  // A hit on the brand's own curated risk terms, same reasoning as
  // BRAND_IMPERSONATION - an analyst-chosen keyword next to the brand is a
  // deliberate signal they asked us to watch for, not routine operational risk.
  ThreatCategory.CUSTOM_KEYWORD_MATCH,
  // Where captured data actually goes, and whether the thing is actually
  // live right now, are both direct evidence of an active operation - not
  // an accidental leak.
  ThreatCategory.SUSPICIOUS_DESTINATION,
  ThreatCategory.CONFIRMED_LIVE,
];

/**
 * A finding can be both (e.g. a phishing kit that also leaks its own admin
 * password) - returns every class that applies, never collapses to one.
 */
export function classifyThreat(
  categories: ThreatCategory[] | undefined | null,
): ThreatClass[] {
  const cats = categories || [];
  const classes: ThreatClass[] = [];
  if (cats.some((c) => CREDENTIAL_EXPOSURE_CATEGORIES.includes(c))) {
    classes.push('credential_exposure');
  }
  if (cats.some((c) => MALICIOUS_INTENT_CATEGORIES.includes(c))) {
    classes.push('malicious_intent');
  }
  if (classes.length === 0) classes.push('other');
  return classes;
}

/** Inverse mapping, used to translate a ?threatClass= filter into a categories query. */
export function categoriesForThreatClass(
  threatClass: ThreatClass,
): ThreatCategory[] {
  if (threatClass === 'credential_exposure')
    return CREDENTIAL_EXPOSURE_CATEGORIES;
  if (threatClass === 'malicious_intent') return MALICIOUS_INTENT_CATEGORIES;
  return [ThreatCategory.SUSPICIOUS_REPO];
}
