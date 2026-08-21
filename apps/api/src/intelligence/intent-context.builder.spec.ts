import { Types } from 'mongoose';
import { IntentContextBuilder } from './intent-context.builder';

function lean(resolved: unknown) {
  return {
    lean: jest
      .fn()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue(resolved) }),
  };
}
function selectLean(resolved: unknown) {
  return { select: jest.fn().mockReturnValue(lean(resolved)) };
}
function sortLean(resolved: unknown) {
  return { sort: jest.fn().mockReturnValue(lean(resolved)) };
}

describe('IntentContextBuilder.build', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const repositoryId = new Types.ObjectId();
  const findingId = new Types.ObjectId();
  const brandId = new Types.ObjectId();

  function buildBuilder(
    overrides: {
      otherRepos?: Array<{ _id: Types.ObjectId }>;
      otherFindings?: Array<{ brandName?: string }>;
      ownFingerprints?: Array<{ kind: string; value: string }>;
      crossOwnerMatches?: Array<{
        owner: string;
        repositoryId: Types.ObjectId;
      }>;
      activeFindingsForMatches?: Array<{ repositoryId: Types.ObjectId }>;
      ownContributors?: Array<{ login: string }>;
      overlapLogins?: string[];
      brand?: { trustedGithubOwners: string[] } | null;
    } = {},
  ) {
    const repo = {
      _id: repositoryId,
      fullName: 'evil/zerodha-clone',
      owner: 'evil',
      description: '',
      topics: [],
      language: 'Python',
      stars: 0,
      forks: 0,
      isFork: false,
      deployment: null,
    };
    const finding = {
      _id: findingId,
      severity: 'critical',
      riskScore: 100,
      categories: ['fake_apk'],
      origin: 'external',
      brandId,
      brandName: 'Zerodha',
    };

    const repoModel = {
      findOne: jest.fn().mockReturnValue(lean(repo)),
      countDocuments: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
      find: jest.fn().mockReturnValue(selectLean(overrides.otherRepos ?? [])),
    };
    const findingModel = {
      findOne: jest.fn().mockReturnValue(sortLean(finding)),
      // find() is called up to twice within getOperatorSignals, in order:
      // first for "otherFindings" (same-owner repeat-operator check), then
      // for "activeFindings" (cross-identity check) - queue both.
      find: jest
        .fn()
        .mockReturnValueOnce(selectLean(overrides.otherFindings ?? []))
        .mockReturnValueOnce(
          selectLean(overrides.activeFindingsForMatches ?? []),
        ),
    };

    const detectionModel = {
      find: jest.fn().mockReturnValue(selectLean([])),
    };

    const fingerprintModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(selectLean(overrides.ownFingerprints ?? []))
        .mockReturnValueOnce(selectLean(overrides.crossOwnerMatches ?? [])),
    };

    const contributorModel = {
      find: jest.fn(),
    };
    const overlapDistinct = {
      distinct: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(overrides.overlapLogins ?? []),
      }),
    };
    // getContributorSignals distinguishes its two find() calls by shape:
    // the first has a plain repositoryId, the second an { $ne } exclusion.
    contributorModel.find.mockImplementation(
      (query: Record<string, unknown>) =>
        (query.repositoryId as Record<string, unknown> | undefined)?.$ne
          ? overlapDistinct
          : selectLean(overrides.ownContributors ?? []),
    );

    const brandModel = {
      findOne: jest.fn().mockReturnValue(selectLean(overrides.brand ?? null)),
    };

    return new IntentContextBuilder(
      repoModel as never,
      findingModel as never,
      detectionModel as never,
      fingerprintModel as never,
      contributorModel as never,
      brandModel as never,
    );
  }

  it('returns baseline zeroed operator/contributor/trust signals when nothing links this repo to anything else', async () => {
    const builder = buildBuilder();
    const context = await builder.build(
      workspaceId,
      repositoryId.toHexString(),
    );

    expect(context?.operatorSignals).toEqual({
      otherBrandsHit: 0,
      linkedIdentityOwners: 0,
    });
    expect(context?.contributors).toEqual({
      count: 0,
      overlapWithOtherRepos: 0,
    });
    expect(context?.trustSignals).toEqual({ isTrustedOwner: false });
    expect(context?.credentials).toEqual([]);
  });

  it('counts distinct other brands hit by the same owner, excluding this repo', async () => {
    const builder = buildBuilder({
      otherRepos: [{ _id: new Types.ObjectId() }],
      otherFindings: [
        { brandName: 'BrandA' },
        { brandName: 'BrandB' },
        { brandName: 'BrandA' },
      ],
    });
    const context = await builder.build(
      workspaceId,
      repositoryId.toHexString(),
    );
    expect(context?.operatorSignals.otherBrandsHit).toBe(2);
  });

  it('reports isTrustedOwner true only when the matched brand actually lists this owner', async () => {
    const builder = buildBuilder({
      brand: { trustedGithubOwners: ['evil', 'someone-else'] },
    });
    const context = await builder.build(
      workspaceId,
      repositoryId.toHexString(),
    );
    expect(context?.trustSignals.isTrustedOwner).toBe(true);
  });

  it("counts this repo's contributors and how many overlap with other repos", async () => {
    const builder = buildBuilder({
      ownContributors: [{ login: 'a' }, { login: 'b' }],
      overlapLogins: ['a'],
    });
    const context = await builder.build(
      workspaceId,
      repositoryId.toHexString(),
    );
    expect(context?.contributors).toEqual({
      count: 2,
      overlapWithOtherRepos: 1,
    });
  });
});
