import { DeepIntentContextBuilder } from './deep-intent-context.builder';

function buildBuilder(config: Record<string, string | number> = {}) {
  const github = {
    getReadme: jest.fn().mockResolvedValue({ text: '', path: 'README.md' }),
    listRootPaths: jest.fn().mockResolvedValue([]),
    getSmallTextFile: jest.fn().mockResolvedValue(null),
  };
  const configService = { get: jest.fn((key: string) => config[key]) };
  const builder = new DeepIntentContextBuilder(
    configService as never,
    github as never,
  );
  return { builder, github };
}

describe('DeepIntentContextBuilder', () => {
  it('truncates the README to the configured max length and marks it truncated', async () => {
    const longReadme = 'x'.repeat(500);
    const { builder, github } = buildBuilder({
      INTELLIGENCE_DEEP_REVIEW_README_MAX_CHARS: 100,
    });
    github.getReadme.mockResolvedValue({ text: longReadme, path: 'README.md' });

    const result = await builder.build('ws', { owner: 'o', name: 'r' }, []);

    expect(result.readme?.text.length).toBe(100);
    expect(result.readme?.truncated).toBe(true);
  });

  it('redacts secret-like values found in README/file content before they leave the builder', async () => {
    const { builder, github } = buildBuilder();
    github.getReadme.mockResolvedValue({
      text: 'Our key is AKIAABCDEFGHIJKLMNOP, do not share it.',
      path: 'README.md',
    });

    const result = await builder.build('ws', { owner: 'o', name: 'r' }, []);

    expect(result.readme?.text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result.readme?.text).toContain('[REDACTED]');
  });

  it('fetches at most the configured number of flagged files, deduplicated', async () => {
    const { builder, github } = buildBuilder({
      INTELLIGENCE_DEEP_REVIEW_MAX_FILES: 2,
    });
    github.getSmallTextFile.mockImplementation(
      (_o: string, _r: string, path: string) =>
        Promise.resolve(`content of ${path}`),
    );

    const result = await builder.build('ws', { owner: 'o', name: 'r' }, [
      'a.js',
      'a.js',
      'b.js',
      'c.js',
    ]);

    expect(result.flaggedFiles.map((f) => f.path)).toEqual(['a.js', 'b.js']);
    expect(github.getSmallTextFile).toHaveBeenCalledTimes(2);
  });

  it('caps the combined total size, dropping the file tree first and flagged files last', async () => {
    const { builder, github } = buildBuilder({
      INTELLIGENCE_DEEP_REVIEW_MAX_TOTAL_CHARS: 50,
      INTELLIGENCE_DEEP_REVIEW_README_MAX_CHARS: 1000,
    });
    github.getReadme.mockResolvedValue({
      text: 'r'.repeat(40),
      path: 'README.md',
    });
    github.listRootPaths.mockResolvedValue(['a.js', 'b.js']);
    github.getSmallTextFile.mockResolvedValue('f'.repeat(40));

    const result = await builder.build('ws', { owner: 'o', name: 'r' }, [
      'a.js',
    ]);

    const totalChars =
      (result.readme?.text.length || 0) +
      (result.manifest?.text.length || 0) +
      result.flaggedFiles.reduce((sum, f) => sum + f.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(50);
    // Flagged files take priority over README when the budget is tight.
    expect(result.flaggedFiles[0]?.text.length).toBe(40);
    expect(result.rootPaths).toBeUndefined();
  });

  it('never fails the whole build when a GitHub call throws - returns an empty section instead', async () => {
    const { builder, github } = buildBuilder();
    github.getReadme.mockRejectedValue(new Error('rate limited'));
    github.listRootPaths.mockRejectedValue(new Error('rate limited'));

    const result = await builder.build('ws', { owner: 'o', name: 'r' }, []);

    expect(result.readme).toBeUndefined();
    expect(result.rootPaths).toEqual([]);
  });
});
