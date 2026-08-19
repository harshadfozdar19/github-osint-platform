import { dedupeKeywordsCaseInsensitive } from './dedupe-keywords';

describe('dedupeKeywordsCaseInsensitive', () => {
  it('collapses case-only duplicates, keeping the first occurrence', () => {
    expect(
      dedupeKeywordsCaseInsensitive(['zerodha', 'kite trading', 'Zerodha']),
    ).toEqual(['zerodha', 'kite trading']);
  });

  it('trims whitespace and treats trimmed values as duplicates too', () => {
    expect(dedupeKeywordsCaseInsensitive(['otp ', ' OTP', 'otp'])).toEqual([
      'otp',
    ]);
  });

  it('drops blank/whitespace-only entries', () => {
    expect(dedupeKeywordsCaseInsensitive(['zerodha', '', '   '])).toEqual([
      'zerodha',
    ]);
  });

  it('keeps genuinely different keywords untouched, in order', () => {
    const input = ['Kite', 'Kite by Zerodha', 'Coin', 'Coin by Zerodha'];
    expect(dedupeKeywordsCaseInsensitive(input)).toEqual(input);
  });

  it('returns an empty array for an empty or all-blank input', () => {
    expect(dedupeKeywordsCaseInsensitive([])).toEqual([]);
    expect(dedupeKeywordsCaseInsensitive(['', '  '])).toEqual([]);
  });
});
