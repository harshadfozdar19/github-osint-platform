import {
  findBestBrandMatch,
  findBrandMatch,
  findKeywordMatches,
} from './brand-match';

const angelOne = {
  name: 'AngelOne',
  aliases: ['angelone', 'angel broking'],
  trustedGithubOwners: ['angel-one-tech'],
};

describe('findBrandMatch', () => {
  it('returns a trusted_owner match before checking any content', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'angel-one-tech',
      repoName: 'backend-services',
      description: 'Internal tooling, no brand mention at all',
      topics: [],
    });
    expect(result).toEqual({
      type: 'trusted_owner',
      location: 'owner',
      matchedAlias: 'angel-one-tech',
      matchedText: 'angel-one-tech',
    });
  });

  it('is case-insensitive for the trusted-owner check', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'Angel-One-Tech',
      repoName: 'x',
      description: '',
      topics: [],
    });
    expect(result?.type).toBe('trusted_owner');
  });

  it('finds an exact match in the repo name', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'evil',
      repoName: 'angelone-login-clone',
      description: '',
      topics: [],
    });
    expect(result).toMatchObject({ type: 'exact', location: 'repo_name' });
  });

  it('finds an exact match in the README content', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'trading-tools',
      description: '',
      topics: [],
      readmeText: 'A comparison of brokers including AngelOne and others.',
    });
    expect(result).toMatchObject({ type: 'exact', location: 'readme' });
    expect(result?.matchedText).toContain('AngelOne');
  });

  it('finds an exact match in a deeply nested file path', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'trading-app',
      description: '',
      topics: [],
      filePaths: ['src/assets/logos/angelone-icon.svg', 'src/index.ts'],
    });
    expect(result).toMatchObject({ type: 'exact', location: 'file_path' });
    expect(result?.matchedText).toContain('angelone-icon.svg');
  });

  it('finds a fuzzy match in a nested folder name', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'trading-app',
      description: '',
      topics: [],
      filePaths: ['src/brokers/angelon/client.ts'],
    });
    expect(result).toMatchObject({ type: 'fuzzy', location: 'file_path' });
  });

  it('uses a full-repo grep hit for file_content evidence, including its line number', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'trading-app',
      description: '',
      topics: [],
      fullRepoTextMatches: [
        {
          alias: 'angelone',
          path: 'src/deep/nested/scraper.py',
          lineNumber: 87,
          line: 'session.login("angelone", creds)',
        },
      ],
    });
    expect(result).toMatchObject({
      type: 'exact',
      location: 'file_content',
      matchedAlias: 'angelone',
      filePath: 'src/deep/nested/scraper.py',
      lineNumber: 87,
    });
  });

  it('ignores a full-repo grep hit whose alias is not actually one of the brand aliases', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'unrelated-project',
      description: 'A generic trading wallet app',
      topics: ['wallet', 'trading'],
      fullRepoTextMatches: [
        { alias: 'someunrelatedterm', path: 'a.py', lineNumber: 1, line: 'x' },
      ],
    });
    expect(result).toBeNull();
  });

  it('finds an exact match in file content', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'x',
      description: '',
      topics: [],
      fileTexts: [{ path: 'config.json', content: '{"broker": "angelone"}' }],
    });
    expect(result).toMatchObject({ type: 'exact', location: 'file_content' });
  });

  it('finds an exact match in a commit message', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'x',
      description: '',
      topics: [],
      commitMessages: ['fix angelone integration bug'],
    });
    expect(result).toMatchObject({ type: 'exact', location: 'commit_message' });
  });

  it('finds an exact match in a commit author name', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'x',
      description: '',
      topics: [],
      commitAuthors: ['AngelOne Bot'],
    });
    expect(result).toMatchObject({ type: 'exact', location: 'commit_author' });
  });

  it('finds a fuzzy word match when no exact substring exists anywhere', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'x',
      description: '',
      topics: [],
      readmeText: 'A tool for tracking angelon portfolios',
    });
    expect(result).toMatchObject({ type: 'fuzzy', location: 'readme' });
  });

  it('prefers an exact match over a fuzzy one even if the fuzzy hit appears first', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'angelon-tools',
      description: '',
      topics: [],
      readmeText: 'Also compatible with AngelOne exports.',
    });
    expect(result?.type).toBe('exact');
  });

  it('returns null when nothing matches anywhere', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'unrelated-project',
      description: 'A generic trading wallet app',
      topics: ['wallet', 'trading'],
      readmeText: 'Supports login, wallet, and OTP verification.',
    });
    expect(result).toBeNull();
  });

  it('does not treat generic keywords like "wallet" or "trading" as a brand match', () => {
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'wallet-trading-login-app',
      description: 'wallet trading otp verification mod',
      topics: ['wallet', 'trading', 'login'],
    });
    expect(result).toBeNull();
  });

  it('does not fuzzy-match a short, unrelated word to a much longer brand name (regression: "anon" vs "angelone")', () => {
    // Real report: a repo using Supabase (VITE_SUPABASE_ANON_KEY=...) in its
    // README got attributed to AngelOne purely because "anon" scores 0.867
    // against "angelone" on raw Jaro-Winkler (shared "an" prefix + a couple
    // of stray character matches) - zero semantic relationship to the
    // brand. A genuine typosquat (angelon, angleone) is near-identical in
    // length to the real name; "anon" (4 chars) vs "angelone" (8 chars) is
    // not that shape at all.
    const result = findBrandMatch(angelOne, {
      ownerLogin: 'someone',
      repoName: 'bachat-ai',
      description: '',
      topics: [],
      readmeText: 'VITE_SUPABASE_ANON_KEY=your-public-anon-key',
    });
    expect(result).toBeNull();
  });
});

describe('findBestBrandMatch', () => {
  const phonepe = { name: 'PhonePe', aliases: ['phonepe'] };

  it('picks the brand with the strongest evidence across the whole monitored list', () => {
    const result = findBestBrandMatch([angelOne, phonepe], {
      ownerLogin: 'someone',
      repoName: 'x',
      description: '',
      topics: [],
      readmeText: 'A fuzzy angelon mention and an exact phonepe integration.',
    });
    expect(result?.brand.name).toBe('PhonePe');
    expect(result?.evidence.type).toBe('exact');
  });

  it('finds a brand whose only mention is deep in a full-repo grep hit, not in any metadata', () => {
    const result = findBestBrandMatch([angelOne, phonepe], {
      ownerLogin: 'someone',
      repoName: 'unrelated-tool',
      description: 'A generic internal utility',
      topics: [],
      fullRepoTextMatches: [
        {
          alias: 'phonepe',
          path: 'src/deep/scraper.py',
          lineNumber: 12,
          line: 'endpoint = "phonepe.com/pay"',
        },
      ],
    });
    expect(result?.brand.name).toBe('PhonePe');
    expect(result?.evidence.filePath).toBe('src/deep/scraper.py');
  });

  it('returns null when no monitored brand matches anywhere', () => {
    const result = findBestBrandMatch([angelOne, phonepe], {
      ownerLogin: 'someone',
      repoName: 'unrelated-project',
      description: 'A generic trading wallet app',
      topics: ['wallet', 'trading'],
    });
    expect(result).toBeNull();
  });

  it('prefers a fuzzy match in the repo\'s own name over a different brand\'s exact match buried in file content (the "search AngelOne, get Google" bug)', () => {
    const google = { name: 'Google', aliases: ['google'] };
    const result = findBestBrandMatch([angelOne, google], {
      ownerLogin: 'someone',
      // Typo'd "angleone" - only a fuzzy hit, but it's in the repo's own name.
      repoName: 'angleone-trading-clone',
      description: 'A trading app',
      topics: [],
      // Completely routine SDK integration mention - not impersonation.
      fileTexts: [
        { path: 'README.md', content: 'Uses Google Sign-In for auth.' },
      ],
    });
    expect(result?.brand.name).toBe('AngelOne');
    expect(result?.evidence.type).toBe('fuzzy');
  });

  it('still lets an exact match win when both hits are in equally weak (content) locations', () => {
    const google = { name: 'Google', aliases: ['google'] };
    const result = findBestBrandMatch([angelOne, google], {
      ownerLogin: 'someone',
      repoName: 'unrelated-tool',
      description: '',
      topics: [],
      fileTexts: [
        {
          path: 'notes.txt',
          content: 'a fuzzy angelon mention and an exact google mention',
        },
      ],
    });
    expect(result?.brand.name).toBe('Google');
    expect(result?.evidence.type).toBe('exact');
  });
});

describe('findKeywordMatches', () => {
  it('never reports a fuzzy match - a near-miss on a keyword is not the same claim as a near-miss on a brand name', () => {
    // "tradng" (missing the "i") is not a substring of "trading" but is
    // close enough that findBrandMatch's fuzzy pass would normally catch it
    // (Jaro-Winkler on tokens) - must not for keywords.
    const results = findKeywordMatches(['trading'], {
      repoName: 'some-tradng-tool',
      description: '',
      topics: [],
    });
    expect(results).toEqual([]);
  });

  it('reports each matched keyword with exact location and text', () => {
    const results = findKeywordMatches(['otp', 'trading', 'nonexistent'], {
      repoName: 'zerodha-otp-bypass-tool',
      description: 'A trading utility',
      topics: [],
    });
    expect(results).toEqual([
      {
        keyword: 'otp',
        evidence: expect.objectContaining({
          type: 'exact',
          location: 'repo_name',
          matchedAlias: 'otp',
        }),
      },
      {
        keyword: 'trading',
        evidence: expect.objectContaining({
          type: 'exact',
          location: 'description',
          matchedAlias: 'trading',
        }),
      },
    ]);
  });

  it('returns no results when none of the keywords appear anywhere', () => {
    const results = findKeywordMatches(['otp', 'kyc'], {
      repoName: 'unrelated-tool',
      description: 'Nothing suspicious here',
      topics: [],
    });
    expect(results).toEqual([]);
  });

  it('skips blank keyword entries', () => {
    const results = findKeywordMatches(['', '   ', 'otp'], {
      repoName: 'otp-tool',
      description: '',
      topics: [],
    });
    expect(results).toEqual([
      { keyword: 'otp', evidence: expect.objectContaining({ type: 'exact' }) },
    ]);
  });

  it('caps results at maxMatches', () => {
    const results = findKeywordMatches(
      ['login', 'otp', 'trading', 'kyc'],
      {
        repoName: 'login-otp-trading-kyc-tool',
        description: '',
        topics: [],
      },
      2,
    );
    expect(results).toHaveLength(2);
  });

  it('reports file content location with path and line number', () => {
    const results = findKeywordMatches(['stealer'], {
      repoName: 'clean-name',
      description: '',
      topics: [],
      fileTexts: [
        { path: 'src/index.js', content: 'line one\na stealer payload here' },
      ],
    });
    expect(results).toEqual([
      {
        keyword: 'stealer',
        evidence: expect.objectContaining({
          location: 'file_content',
          filePath: 'src/index.js',
          lineNumber: 2,
        }),
      },
    ]);
  });
});
