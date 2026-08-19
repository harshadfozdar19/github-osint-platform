import { RepoAnalysisContext } from '../detection/rules/rule.types';
import { hashContent } from './code-fingerprint.util';
import {
  findFileHashReuseMatches,
  findPhraseReuseMatches,
} from './content-reuse.util';

const baseCtx = (
  overrides: Partial<RepoAnalysisContext> = {},
): RepoAnalysisContext => ({
  fullName: 'evil/clone-app',
  owner: 'evil',
  name: 'clone-app',
  description: '',
  topics: [],
  language: 'JavaScript',
  stars: 0,
  forks: 0,
  isFork: false,
  githubCreatedAt: new Date(),
  filePaths: [],
  readmeText: '',
  smallFileTexts: [],
  ...overrides,
});

describe('findPhraseReuseMatches', () => {
  const phrase = 'Track your shipment in real time with Acme Express';

  it('returns [] when there are no known phrases', () => {
    const ctx = baseCtx({
      smallFileTexts: [{ path: 'src/en.json', content: phrase }],
    });
    expect(findPhraseReuseMatches(ctx, [])).toEqual([]);
  });

  it('returns [] when none of the known phrases appear anywhere', () => {
    const ctx = baseCtx({
      smallFileTexts: [{ path: 'src/en.json', content: 'unrelated text' }],
    });
    expect(findPhraseReuseMatches(ctx, [phrase])).toEqual([]);
  });

  it('finds a phrase copied verbatim into a file, with file/line evidence', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        {
          path: 'src/locales/en.json',
          content: `intro line\n${phrase}\nmore text`,
        },
      ],
    });
    const matches = findPhraseReuseMatches(ctx, [phrase]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: 'phrase',
      file: 'src/locales/en.json',
      lineNumber: 2,
      matchedText: phrase,
    });
    expect(matches[0].evidence).toContain(phrase);
  });

  it('matches case-insensitively', () => {
    const ctx = baseCtx({
      smallFileTexts: [{ path: 'a.txt', content: phrase.toUpperCase() }],
    });
    expect(findPhraseReuseMatches(ctx, [phrase])).toHaveLength(1);
  });

  it('finds a phrase in the README, resolved to its real path', () => {
    const ctx = baseCtx({ readmeText: phrase, readmePath: 'docs/README.rst' });
    const matches = findPhraseReuseMatches(ctx, [phrase]);
    expect(matches[0].file).toBe('docs/README.rst');
  });

  it('finds a phrase in the repo description, with no file link', () => {
    const ctx = baseCtx({ description: phrase });
    const matches = findPhraseReuseMatches(ctx, [phrase]);
    expect(matches[0].file).toBeUndefined();
  });

  it('records only the first occurrence of a phrase per file, not every repeated line', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        { path: 'a.txt', content: `${phrase}\n${phrase}\n${phrase}` },
      ],
    });
    expect(findPhraseReuseMatches(ctx, [phrase])).toHaveLength(1);
  });

  it('caps total matches instead of growing unbounded', () => {
    const manyPhrases = Array.from(
      { length: 20 },
      (_, i) => `distinctive phrase number ${i}`,
    );
    const ctx = baseCtx({
      smallFileTexts: manyPhrases.map((p, i) => ({
        path: `f${i}.txt`,
        content: p,
      })),
    });
    const matches = findPhraseReuseMatches(ctx, manyPhrases);
    expect(matches.length).toBeLessThanOrEqual(10);
  });
});

describe('findFileHashReuseMatches', () => {
  const bigContent = 'x'.repeat(500);
  const knownHash = hashContent(bigContent);

  it('returns [] when there are no known hashes', () => {
    const ctx = baseCtx({
      smallFileTexts: [{ path: 'a.txt', content: bigContent }],
    });
    expect(findFileHashReuseMatches(ctx, new Set())).toEqual([]);
  });

  it('flags a file whose content hash matches a known reference file exactly', () => {
    const ctx = baseCtx({
      smallFileTexts: [
        { path: 'src/templates/email.html', content: bigContent },
      ],
    });
    const matches = findFileHashReuseMatches(ctx, new Set([knownHash]));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: 'file_hash',
      file: 'src/templates/email.html',
    });
  });

  it('does not flag a file with different content', () => {
    const ctx = baseCtx({
      smallFileTexts: [{ path: 'a.txt', content: 'y'.repeat(500) }],
    });
    expect(findFileHashReuseMatches(ctx, new Set([knownHash]))).toEqual([]);
  });

  it('skips files below the minimum size threshold, even on an exact hash match', () => {
    const tinyContent = '{}';
    const tinyHash = hashContent(tinyContent);
    const ctx = baseCtx({
      smallFileTexts: [{ path: 'empty.json', content: tinyContent }],
    });
    expect(findFileHashReuseMatches(ctx, new Set([tinyHash]))).toEqual([]);
  });

  it('also checks the README content', () => {
    const ctx = baseCtx({ readmeText: bigContent, readmePath: 'README.rst' });
    const matches = findFileHashReuseMatches(ctx, new Set([knownHash]));
    expect(matches[0].file).toBe('README.rst');
  });

  it('caps total matches instead of growing unbounded', () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `f${i}.txt`,
      content: `${i}`.repeat(500),
    }));
    const knownHashes = new Set(files.map((f) => hashContent(f.content)));
    const ctx = baseCtx({ smallFileTexts: files });
    const matches = findFileHashReuseMatches(ctx, knownHashes);
    expect(matches.length).toBeLessThanOrEqual(10);
  });
});
