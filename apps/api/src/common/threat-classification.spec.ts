import { ThreatCategory } from './enums';
import {
  categoriesForThreatClass,
  classifyThreat,
} from './threat-classification';

describe('classifyThreat', () => {
  it('classifies exposed secrets as credential_exposure', () => {
    expect(classifyThreat([ThreatCategory.EXPOSED_SECRET])).toEqual([
      'credential_exposure',
    ]);
  });

  it('classifies phishing/impersonation/apk/malware as malicious_intent', () => {
    for (const cat of [
      ThreatCategory.BRAND_IMPERSONATION,
      ThreatCategory.PHISHING,
      ThreatCategory.FAKE_APK,
      ThreatCategory.MALWARE,
    ]) {
      expect(classifyThreat([cat])).toEqual(['malicious_intent']);
    }
  });

  it('returns both classes when a finding has both kinds of category', () => {
    expect(
      classifyThreat([ThreatCategory.EXPOSED_SECRET, ThreatCategory.PHISHING]),
    ).toEqual(['credential_exposure', 'malicious_intent']);
  });

  it('falls back to "other" for categories in neither bucket', () => {
    expect(classifyThreat([ThreatCategory.SUSPICIOUS_REPO])).toEqual(['other']);
  });

  it('handles empty/missing categories as "other"', () => {
    expect(classifyThreat([])).toEqual(['other']);
    expect(classifyThreat(undefined)).toEqual(['other']);
    expect(classifyThreat(null)).toEqual(['other']);
  });
});

describe('categoriesForThreatClass', () => {
  it('round-trips with classifyThreat for each class', () => {
    expect(
      classifyThreat(categoriesForThreatClass('credential_exposure')),
    ).toEqual(['credential_exposure']);
    expect(
      classifyThreat(categoriesForThreatClass('malicious_intent')),
    ).toEqual(['malicious_intent']);
  });
});
