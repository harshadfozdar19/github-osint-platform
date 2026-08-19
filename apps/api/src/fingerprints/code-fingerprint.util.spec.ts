import {
  computeChunkFingerprints,
  hashContent,
  tokenize,
} from './code-fingerprint.util';

/** Deterministic filler so generated fixtures don't accidentally share k-grams with each other. */
function loremTokens(n: number, seedWord = 'lorem'): string {
  const words = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
    'kilo',
    'lima',
    'mike',
    'november',
  ];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${seedWord}${i}_${words[i % words.length]}`);
  }
  return out.join(' ');
}

describe('tokenize', () => {
  it('treats runs of word characters as single tokens', () => {
    expect(tokenize('helloWorld123 foo_bar')).toEqual([
      'helloWorld123',
      'foo_bar',
    ]);
  });

  it('treats each punctuation/operator character as its own token', () => {
    expect(tokenize('a=b+1;')).toEqual(['a', '=', 'b', '+', '1', ';']);
  });

  it('is blind to whitespace amount and kind', () => {
    const a = tokenize('function foo() {\n  return 1;\n}');
    const b = tokenize('function   foo()   {\treturn 1;\t}');
    expect(a).toEqual(b);
  });

  it('returns an empty array for empty or whitespace-only content', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \n\t  ')).toEqual([]);
  });
});

describe('hashContent', () => {
  it('is deterministic', () => {
    const content = 'const x = 1;\nconsole.log(x);\n';
    expect(hashContent(content)).toBe(hashContent(content));
  });

  it('is unaffected by CRLF vs LF line endings', () => {
    const lf = 'line one\nline two\nline three';
    const crlf = 'line one\r\nline two\r\nline three';
    expect(hashContent(lf)).toBe(hashContent(crlf));
  });

  it('is unaffected by trailing whitespace on lines', () => {
    const a = 'line one\nline two';
    const b = 'line one   \nline two\t';
    expect(hashContent(a)).toBe(hashContent(b));
  });

  it('differs when actual content differs', () => {
    expect(hashContent('const x = 1;')).not.toBe(hashContent('const x = 2;'));
  });

  it('produces a 64-char hex sha256 digest', () => {
    expect(hashContent('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeChunkFingerprints', () => {
  it('returns [] for empty content', () => {
    expect(computeChunkFingerprints('')).toEqual([]);
  });

  it('is deterministic for identical content', () => {
    const content = loremTokens(500);
    expect(computeChunkFingerprints(content)).toEqual(
      computeChunkFingerprints(content),
    );
  });

  it('is identical for content that only differs by whitespace/indentation', () => {
    const original = `function process(${loremTokens(30)}) {\n  return true;\n}`;
    const reformatted = `function process(${loremTokens(30)})\n{\n\t\treturn true;\n}\n\n\n`;
    // tokenize() strips whitespace entirely, so reformatting alone must
    // never change the fingerprint set - this is the "same code, different
    // structure/indentation" case the whole detector exists for.
    const fpA = computeChunkFingerprints(original);
    const fpB = computeChunkFingerprints(reformatted);
    expect(fpA).toEqual(fpB);
    expect(fpA.length).toBeGreaterThan(0);
  });

  it('produces mostly-overlapping (but not identical) fingerprints when a few tokens are changed in a large file', () => {
    // With kgram=25, a single changed token corrupts the ~25 k-gram windows
    // that contain it - so "small edit" only stays small in *fingerprint*
    // terms if the edits are a small fraction of (tokenCount / kgram), not
    // just a small fraction of tokenCount itself. 3 edits * 25 tokens each
    // against 2000 tokens (=80 k-gram-widths) keeps the corrupted region a
    // small slice of the file.
    const tokenCount = 2000;
    const base = loremTokens(tokenCount, 'base');
    const words = [
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      'india',
      'juliet',
      'kilo',
      'lima',
      'mike',
      'november',
    ];
    let edited = base;
    for (const i of [200, 900, 1600]) {
      const original = `base${i}_${words[i % words.length]}`;
      edited = edited.replace(original, `RENAMED_${i}`);
    }

    const fpBase = new Set(computeChunkFingerprints(base));
    const fpEdited = new Set(computeChunkFingerprints(edited));
    const shared = [...fpBase].filter((h) => fpEdited.has(h));

    expect(fpBase).not.toEqual(fpEdited);
    expect(shared.length / fpBase.size).toBeGreaterThan(0.8);
  });

  it('has near-zero overlap between two unrelated large texts', () => {
    const a = loremTokens(400, 'setA');
    const b = loremTokens(400, 'setB');
    const fpA = new Set(computeChunkFingerprints(a));
    const fpB = new Set(computeChunkFingerprints(b));
    const shared = [...fpA].filter((h) => fpB.has(h));
    expect(shared.length).toBe(0);
  });

  it('detects a copied snippet even when embedded inside unrelated surrounding content', () => {
    const snippet = loremTokens(60, 'stolen_snippet');
    const originalFile = `${loremTokens(50, 'orig_prefix')} ${snippet} ${loremTokens(50, 'orig_suffix')}`;
    const copiedIntoOtherFile = `${loremTokens(80, 'other_prefix')} ${snippet} ${loremTokens(80, 'other_suffix')}`;
    const unrelatedFile = `${loremTokens(200, 'totally_unrelated')}`;

    const fpOriginal = new Set(computeChunkFingerprints(originalFile));
    const fpCopy = new Set(computeChunkFingerprints(copiedIntoOtherFile));
    const fpUnrelated = new Set(computeChunkFingerprints(unrelatedFile));

    const sharedWithCopy = [...fpOriginal].filter((h) => fpCopy.has(h));
    const sharedWithUnrelated = [...fpOriginal].filter((h) =>
      fpUnrelated.has(h),
    );

    expect(sharedWithCopy.length).toBeGreaterThan(0);
    expect(sharedWithUnrelated.length).toBe(0);
  });

  it('still returns a non-empty, matchable fingerprint for content shorter than one k-gram', () => {
    const a = computeChunkFingerprints('const x = 1;', { kgram: 25 });
    const b = computeChunkFingerprints('const x = 1;', { kgram: 25 });
    const c = computeChunkFingerprints('const y = 2;', { kgram: 25 });
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('bounds fingerprint count well below the raw k-gram count for large input (winnowing actually reduces density)', () => {
    const content = loremTokens(2000, 'dense');
    const kgram = 25;
    const window = 4;
    const tokenCount = tokenize(content).length;
    const rawKgramCount = tokenCount - kgram + 1;
    const fingerprints = computeChunkFingerprints(content, { kgram, window });
    expect(fingerprints.length).toBeGreaterThan(0);
    expect(fingerprints.length).toBeLessThan(rawKgramCount);
  });

  it('rejects invalid kgram/window options', () => {
    expect(() => computeChunkFingerprints('x', { kgram: 0 })).toThrow();
    expect(() => computeChunkFingerprints('x', { window: 0 })).toThrow();
  });
});
