import {
  findAliasWordMatch,
  findWordBoundaryIndex,
  hasWordBoundaryMatch,
} from './word-match.util';

describe('hasWordBoundaryMatch', () => {
  it('rejects the needle buried mid-word inside an unrelated longer word', () => {
    expect(hasWordBoundaryMatch('identifyers', 'fyers')).toBe(false);
    expect(hasWordBoundaryMatch('modifyers', 'fyers')).toBe(false);
    expect(hasWordBoundaryMatch('a list of identifyers here', 'fyers')).toBe(
      false,
    );
  });

  it('accepts the needle as its own standalone word', () => {
    expect(hasWordBoundaryMatch('fyers', 'fyers')).toBe(true);
    expect(hasWordBoundaryMatch('this is fyers, a broker', 'fyers')).toBe(true);
    expect(hasWordBoundaryMatch('Fyers OAuth callback', 'fyers')).toBe(true);
  });

  it('accepts camelCase/PascalCase compound identifiers', () => {
    expect(hasWordBoundaryMatch('fyersModel', 'fyers')).toBe(true);
    expect(hasWordBoundaryMatch('FyersModel', 'fyers')).toBe(true);
    expect(hasWordBoundaryMatch('MyFyersClient', 'fyers')).toBe(true);
  });

  it('accepts snake_case and dotted/path-separated identifiers', () => {
    expect(hasWordBoundaryMatch('fyers_callback', 'fyers')).toBe(true);
    expect(
      hasWordBoundaryMatch('fyers.get_profile(token=token)', 'fyers'),
    ).toBe(true);
    expect(hasWordBoundaryMatch("@app.route('/fyers/callback')", 'fyers')).toBe(
      true,
    );
    expect(hasWordBoundaryMatch('def fyers_callback():', 'fyers')).toBe(true);
  });

  it('rejects a needle that is only a suffix of a larger lowercase run', () => {
    // "specify" ends in "ify", not "fyers" - sanity check the matcher only
    // ever evaluates boundaries at positions where the substring truly
    // occurs, not near-misses.
    expect(hasWordBoundaryMatch('specify', 'fyers')).toBe(false);
  });

  it('rejects when the needle is a prefix of a larger lowercase-continued word', () => {
    expect(hasWordBoundaryMatch('fyersome', 'fyers')).toBe(false);
    expect(hasWordBoundaryMatch('fyers2home', 'fyers')).toBe(false);
  });

  it('is case-insensitive on the haystack side regardless of needle casing', () => {
    expect(hasWordBoundaryMatch('FYERS is a broker', 'fyers')).toBe(true);
  });

  it('handles an empty needle or haystack without throwing', () => {
    expect(hasWordBoundaryMatch('anything', '')).toBe(false);
    expect(hasWordBoundaryMatch('', 'fyers')).toBe(false);
  });
});

describe('findWordBoundaryIndex', () => {
  it('returns -1 when every occurrence is buried mid-word', () => {
    expect(findWordBoundaryIndex('identifyers', 'fyers')).toBe(-1);
  });

  it('skips a buried false-positive occurrence and finds a later genuine one', () => {
    const haystack = 'a list of identifyers, then fyers itself';
    const idx = findWordBoundaryIndex(haystack, 'fyers');
    expect(idx).toBe(haystack.toLowerCase().lastIndexOf('fyers'));
  });
});

describe('findAliasWordMatch', () => {
  it('returns the first alias (in list order) with a genuine word-boundary hit', () => {
    const result = findAliasWordMatch('fyersModel.FyersModel(is_async)', [
      'zerodha',
      'fyers',
    ]);
    expect(result).toEqual({ alias: 'fyers', index: 0 });
  });

  it('returns null when no alias has a genuine hit, even if one is buried mid-word', () => {
    const result = findAliasWordMatch('a repo about identifyers', [
      'fyers',
      'zerodha',
    ]);
    expect(result).toBeNull();
  });
});
