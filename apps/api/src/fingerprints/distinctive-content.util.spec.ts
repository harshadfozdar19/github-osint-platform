import { extractDistinctivePhrases } from './distinctive-content.util';

describe('extractDistinctivePhrases', () => {
  it('returns [] for empty content', () => {
    expect(extractDistinctivePhrases('')).toEqual([]);
  });

  it('extracts a distinctive quoted value from a locale-style line', () => {
    const content =
      '"welcomeMessage": "Track your shipment in real time with Acme Express"';
    const phrases = extractDistinctivePhrases(content).map((p) => p.text);
    expect(phrases).toContain(
      'Track your shipment in real time with Acme Express',
    );
  });

  it('rejects short/generic quoted UI values', () => {
    const content = '"ok": "OK"\n"cancel": "Cancel"\n"yes": "Yes"';
    expect(extractDistinctivePhrases(content)).toEqual([]);
  });

  it('rejects known ubiquitous boilerplate phrases (case-insensitive)', () => {
    const content = [
      'All Rights Reserved',
      'Terms and Conditions',
      'PRIVACY POLICY',
      'Please try again later',
      'Invalid email or password',
    ].join('\n');
    expect(extractDistinctivePhrases(content)).toEqual([]);
  });

  it('rejects phrases with fewer than 3 significant (non-stopword, 4+ letter) words', () => {
    // "sign", "continue" are stopwords/excluded here by design (generic UI verbs).
    expect(extractDistinctivePhrases('Sign in to continue please')).toEqual([]);
  });

  it('accepts a genuinely distinctive brand sentence with enough significant words', () => {
    const content =
      'Track your shipment in real time with Acme Express nationwide';
    const phrases = extractDistinctivePhrases(content);
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0].significantWordCount).toBeGreaterThanOrEqual(3);
  });

  it('deduplicates identical phrases case-insensitively', () => {
    const content =
      'Track your shipment with Acme Express\nTRACK YOUR SHIPMENT WITH ACME EXPRESS';
    const phrases = extractDistinctivePhrases(content);
    expect(phrases.length).toBe(1);
  });

  it('rejects phrases shorter than the minimum length', () => {
    expect(extractDistinctivePhrases('Acme rocks')).toEqual([]);
  });

  it('rejects phrases longer than the maximum length', () => {
    const longLine =
      'Acme Express delivers packages nationwide with real time tracking and '.repeat(
        5,
      );
    expect(extractDistinctivePhrases(longLine)).toEqual([]);
  });

  it('extracts plain-line prose (no quotes) from README/legal-style content', () => {
    const content =
      'Acme Express is the fastest nationwide logistics network for e-commerce sellers.';
    const phrases = extractDistinctivePhrases(content).map((p) => p.text);
    expect(phrases).toContain(content);
  });

  it('sorts results by significant word count, most distinctive first', () => {
    const content = [
      'Acme Express nationwide delivery tracking', // fewer significant words
      'Acme Express nationwide delivery tracking dashboard analytics reporting console', // more
    ].join('\n');
    const phrases = extractDistinctivePhrases(content);
    expect(phrases.length).toBe(2);
    expect(phrases[0].significantWordCount).toBeGreaterThanOrEqual(
      phrases[1].significantWordCount,
    );
  });

  it('does not crash on content with no letters (pure punctuation/numbers)', () => {
    expect(extractDistinctivePhrases('1234567890 !!!! ---- ====')).toEqual([]);
  });

  it('extracts only the quoted value from a "key": "value" line, not a duplicate raw-line variant', () => {
    const content =
      '"welcomeMessage": "Track your shipment in real time with Acme Express"';
    const phrases = extractDistinctivePhrases(content);
    // Must not also emit the whole raw line (braces/key/quotes included) as
    // a second, noisier candidate alongside the clean value.
    expect(phrases).toHaveLength(1);
    expect(phrases[0].text).toBe(
      'Track your shipment in real time with Acme Express',
    );
  });
});
