import { Types } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import { FindingsService } from './findings.service';
import { FindingStatus, ThreatCategory } from '../common/enums';

describe('FindingsService.getById', () => {
  it('queries detections with findingId cast to a real ObjectId, not a string', async () => {
    // Regression test: Mongoose reliably auto-casts a plain string for the
    // special `_id` field, but does NOT reliably do so for a regular
    // ObjectId-typed field like `findingId` - passing the raw route-param
    // string there silently matched zero documents even when matching
    // detections existed in the database.
    const id = new Types.ObjectId().toHexString();
    const workspaceId = new Types.ObjectId().toHexString();

    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ _id: id, summary: 'test' }),
      }),
    };
    const findSpy = jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });
    const detectionModel = { find: findSpy };
    const repoModel = {};

    const service = new FindingsService(
      findingModel as never,
      detectionModel as never,
      repoModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.getById(workspaceId, id);

    expect(findSpy).toHaveBeenCalledTimes(1);
    const filter = findSpy.mock.calls[0][0] as {
      findingId: unknown;
      workspaceId: unknown;
    };
    expect(filter.findingId).toBeInstanceOf(Types.ObjectId);
    expect((filter.findingId as Types.ObjectId).toHexString()).toBe(id);
    expect(filter.workspaceId).toBeInstanceOf(Types.ObjectId);
  });

  it('throws NotFoundException for a malformed id', async () => {
    const service = new FindingsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.getById(new Types.ObjectId().toHexString(), 'not-an-object-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when no matching finding exists', async () => {
    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      }),
    };
    const service = new FindingsService(
      findingModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.getById(
        new Types.ObjectId().toHexString(),
        new Types.ObjectId().toHexString(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the finding merged with its detections', async () => {
    const id = new Types.ObjectId().toHexString();
    const workspaceId = new Types.ObjectId().toHexString();
    const detections = [
      { ruleId: 'secret-aws-key', file: '.env', lineNumber: 3 },
    ];

    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ _id: id, severity: 'critical' }),
      }),
    };
    const detectionModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(detections),
      }),
    };

    const service = new FindingsService(
      findingModel as never,
      detectionModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.getById(workspaceId, id);
    expect(result.detections).toEqual(detections);
    expect(result.severity).toBe('critical');
  });

  it('attaches a derived threatClass to the finding', async () => {
    const id = new Types.ObjectId().toHexString();
    const workspaceId = new Types.ObjectId().toHexString();
    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({
          _id: id,
          categories: [ThreatCategory.EXPOSED_SECRET, ThreatCategory.PHISHING],
        }),
      }),
    };
    const detectionModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const service = new FindingsService(
      findingModel as never,
      detectionModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.getById(workspaceId, id);
    expect(result.threatClass).toEqual([
      'credential_exposure',
      'malicious_intent',
    ]);
  });

  it('attaches linkedIdentities from other repos sharing a fingerprint', async () => {
    const id = new Types.ObjectId().toHexString();
    const workspaceId = new Types.ObjectId().toHexString();
    const repositoryId = new Types.ObjectId().toHexString();
    const otherRepositoryId = new Types.ObjectId();

    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({
          _id: id,
          repositoryId: { _id: new Types.ObjectId(repositoryId) },
        }),
      }),
    };
    const detectionModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const fingerprintFindSpy = jest
      .fn()
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockResolvedValue([{ kind: 'email', value: 'scam@gmail.com' }]),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          {
            kind: 'email',
            value: 'scam@gmail.com',
            owner: 'other-owner',
            fullName: 'other-owner/evil-repo',
            repositoryId: otherRepositoryId,
          },
        ]),
      });
    const fingerprintModel = { find: fingerprintFindSpy };
    const contributorModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };

    const service = new FindingsService(
      findingModel as never,
      detectionModel as never,
      {} as never,
      fingerprintModel as never,
      contributorModel as never,
      {} as never,
      {} as never,
    );

    const result = await service.getById(workspaceId, id);
    expect(result.linkedIdentities).toEqual([
      {
        kind: 'email',
        value: 'scam@gmail.com',
        owner: 'other-owner',
        fullName: 'other-owner/evil-repo',
        repositoryId: String(otherRepositoryId),
      },
    ]);
  });
});

describe('FindingsService.getLinkedIdentities', () => {
  it('returns an empty array when this repo has no fingerprints of its own', async () => {
    const fingerprintModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const service = new FindingsService(
      {} as never,
      {} as never,
      {} as never,
      fingerprintModel as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.getLinkedIdentities(
      new Types.ObjectId().toHexString(),
      new Types.ObjectId().toHexString(),
    );
    expect(result).toEqual([]);
    expect(fingerprintModel.find).toHaveBeenCalledTimes(1);
  });

  it('excludes this same repo from its own cross-owner match query', async () => {
    const workspaceId = new Types.ObjectId().toHexString();
    const repositoryId = new Types.ObjectId().toHexString();
    const findSpy = jest
      .fn()
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockResolvedValue([{ kind: 'telegram', value: 'scamhandle' }]),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
    const fingerprintModel = { find: findSpy };

    await new FindingsService(
      {} as never,
      {} as never,
      {} as never,
      fingerprintModel as never,
      {} as never,
      {} as never,
      {} as never,
    ).getLinkedIdentities(workspaceId, repositoryId);

    // Second call is the cross-owner lookup - must exclude this repositoryId.
    const secondCallFilter = findSpy.mock.calls[1][0] as {
      repositoryId?: { $ne: Types.ObjectId };
    };
    expect(secondCallFilter.repositoryId?.$ne.toHexString()).toBe(repositoryId);
  });
});

describe('FindingsService.getContributors', () => {
  it('returns an empty array when this repo has no contributor rows of its own', async () => {
    const contributorModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const service = new FindingsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      contributorModel as never,
      {} as never,
      {} as never,
    );

    const result = await service.getContributors(
      new Types.ObjectId().toHexString(),
      new Types.ObjectId().toHexString(),
    );
    expect(result).toEqual([]);
    expect(contributorModel.find).toHaveBeenCalledTimes(1);
  });

  it('annotates each contributor with the other repos in this workspace they also appear in', async () => {
    const workspaceId = new Types.ObjectId().toHexString();
    const repositoryId = new Types.ObjectId().toHexString();
    const otherRepositoryId = new Types.ObjectId();
    const findSpy = jest
      .fn()
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          { login: 'shared-dev', avatarUrl: 'https://x/a.png', contributions: 12 },
        ]),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          {
            login: 'shared-dev',
            repositoryId: otherRepositoryId,
            fullName: 'other-owner/evil-clone',
          },
        ]),
      });
    const contributorModel = { find: findSpy };

    const result = await new FindingsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      contributorModel as never,
      {} as never,
      {} as never,
    ).getContributors(workspaceId, repositoryId);

    expect(result).toEqual([
      {
        login: 'shared-dev',
        avatarUrl: 'https://x/a.png',
        contributions: 12,
        otherRepositories: [
          { repositoryId: String(otherRepositoryId), fullName: 'other-owner/evil-clone' },
        ],
      },
    ]);

    // Second call is the cross-repo lookup - must exclude this repositoryId.
    const secondCallFilter = findSpy.mock.calls[1][0] as {
      repositoryId?: { $ne: Types.ObjectId };
    };
    expect(secondCallFilter.repositoryId?.$ne.toHexString()).toBe(repositoryId);
  });
});

describe('FindingsService.list threatClass filtering', () => {
  function buildService(execResult: unknown[] = []) {
    const findSpy = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(execResult),
    });
    const findingModel = {
      find: findSpy,
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(execResult.length),
      }),
    };
    // list() always resolves eligible (non-pending-analysis) repo ids first
    // to restrict the findings query - these tests don't exercise that
    // restriction itself, so an empty match set is fine.
    const repoModel = {
      find: jest.fn().mockReturnValue({
        distinct: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    const service = new FindingsService(
      findingModel as never,
      {} as never,
      repoModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, findSpy };
  }

  it('filters by threatClass alone via a categories $in query', async () => {
    const { service, findSpy } = buildService();
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      threatClass: 'malicious_intent',
    });
    const query = findSpy.mock.calls[0][0] as { categories?: unknown };
    expect(query.categories).toEqual({
      $in: [
        ThreatCategory.BRAND_IMPERSONATION,
        ThreatCategory.PHISHING,
        ThreatCategory.FAKE_APK,
        ThreatCategory.MALWARE,
        ThreatCategory.CONTENT_REUSE,
        ThreatCategory.CUSTOM_KEYWORD_MATCH,
        ThreatCategory.SUSPICIOUS_DESTINATION,
        ThreatCategory.CONFIRMED_LIVE,
      ],
    });
  });

  it('intersects category + threatClass to nothing when they disagree', async () => {
    const { service, findSpy } = buildService();
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      category: ThreatCategory.EXPOSED_SECRET,
      threatClass: 'malicious_intent',
    });
    const query = findSpy.mock.calls[0][0] as { categories?: unknown };
    expect(query.categories).toEqual({ $in: [] });
  });

  it('keeps the specific category when it matches the requested threatClass', async () => {
    const { service, findSpy } = buildService();
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      category: ThreatCategory.PHISHING,
      threatClass: 'malicious_intent',
    });
    const query = findSpy.mock.calls[0][0] as { categories?: unknown };
    expect(query.categories).toBe(ThreatCategory.PHISHING);
  });

  it('attaches threatClass to every row in the results', async () => {
    const { service } = buildService([
      { _id: '1', categories: [ThreatCategory.EXPOSED_SECRET] },
      { _id: '2', categories: [ThreatCategory.MALWARE] },
    ]);
    const result = await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
    });
    expect(result.data[0].threatClass).toEqual(['credential_exposure']);
    expect(result.data[1].threatClass).toEqual(['malicious_intent']);
  });
});

describe('FindingsService.list deployment filter', () => {
  function buildService(repoFindSpy: jest.Mock) {
    const findSpy = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });
    const findingModel = {
      find: findSpy,
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      }),
    };
    const repoModel = { find: repoFindSpy };
    const service = new FindingsService(
      findingModel as never,
      {} as never,
      repoModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service };
  }

  it('filters repos by deployment presence when hasDeployment=true', async () => {
    const repoFindSpy = jest.fn().mockReturnValue({
      distinct: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
    });
    const { service } = buildService(repoFindSpy);
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      hasDeployment: true,
    });
    const repoFilter = repoFindSpy.mock.calls[0][0] as { deployment?: unknown };
    expect(repoFilter.deployment).toEqual({ $ne: null });
  });

  it('filters repos to "not defined" when hasDeployment=false', async () => {
    const repoFindSpy = jest.fn().mockReturnValue({
      distinct: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
    });
    const { service } = buildService(repoFindSpy);
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      hasDeployment: false,
    });
    const repoFilter = repoFindSpy.mock.calls[0][0] as { deployment?: unknown };
    expect(repoFilter.deployment).toBeNull();
  });
});

describe('FindingsService.list sortBy', () => {
  function buildService() {
    const sortSpy = jest.fn().mockReturnThis();
    const findSpy = jest.fn().mockReturnValue({
      sort: sortSpy,
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });
    const findingModel = {
      find: findSpy,
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      }),
    };
    // See the identical comment in the threatClass-filtering describe block
    // above - list() always resolves eligible repo ids first.
    const repoModel = {
      find: jest.fn().mockReturnValue({
        distinct: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    const service = new FindingsService(
      findingModel as never,
      {} as never,
      repoModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, sortSpy };
  }

  it('sorts by keywordMatchCount descending when requested (most keywords matched first)', async () => {
    const { service, sortSpy } = buildService();
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      sortBy: 'keywordMatchCount',
      sortOrder: 'desc',
    });
    expect(sortSpy).toHaveBeenCalledWith({ keywordMatchCount: -1 });
  });

  it('sorts ascending when explicitly requested (fewest keywords matched first)', async () => {
    const { service, sortSpy } = buildService();
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      sortBy: 'keywordMatchCount',
      sortOrder: 'asc',
    });
    expect(sortSpy).toHaveBeenCalledWith({ keywordMatchCount: 1 });
  });

  it('falls back to createdAt for an unrecognized sortBy value', async () => {
    const { service, sortSpy } = buildService();
    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      sortBy: 'notARealField',
    });
    expect(sortSpy).toHaveBeenCalledWith({ createdAt: -1 });
  });
});

describe('FindingsService.getRulePrecisionStats', () => {
  it('computes a false-positive rate per rule from the aggregation result', async () => {
    const workspaceId = new Types.ObjectId().toHexString();
    const aggregateSpy = jest.fn().mockResolvedValue([
      {
        _id: 'secret-generic-api-token',
        ruleName: 'Generic API Token',
        totalFindings: 10,
        falsePositiveCount: 4,
      },
      {
        _id: 'phishing-kit',
        ruleName: 'Phishing Indicators',
        totalFindings: 5,
        falsePositiveCount: 0,
      },
    ]);
    const detectionModel = { aggregate: aggregateSpy };
    const service = new FindingsService(
      {} as never,
      detectionModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.getRulePrecisionStats(workspaceId);

    expect(aggregateSpy).toHaveBeenCalledTimes(1);
    const pipeline = aggregateSpy.mock.calls[0][0] as Array<{
      $match?: { workspaceId: unknown };
    }>;
    expect(pipeline[0].$match?.workspaceId).toBeInstanceOf(Types.ObjectId);

    expect(result).toEqual([
      {
        ruleId: 'secret-generic-api-token',
        ruleName: 'Generic API Token',
        totalFindings: 10,
        falsePositiveCount: 4,
        falsePositiveRate: 0.4,
      },
      {
        ruleId: 'phishing-kit',
        ruleName: 'Phishing Indicators',
        totalFindings: 5,
        falsePositiveCount: 0,
        falsePositiveRate: 0,
      },
    ]);
  });

  it('returns an empty array when the workspace has no detections yet', async () => {
    const service = new FindingsService(
      {} as never,
      { aggregate: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.getRulePrecisionStats(new Types.ObjectId().toHexString()),
    ).resolves.toEqual([]);
  });
});

describe('FindingsService.updateStatus', () => {
  it('rejects an invalid status value', async () => {
    const service = new FindingsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.updateStatus(
        new Types.ObjectId().toHexString(),
        new Types.ObjectId().toHexString(),
        new Types.ObjectId().toHexString(),
        { status: 'not-a-real-status' as FindingStatus },
      ),
    ).rejects.toThrow();
  });
});

describe('FindingsService.verifyDetectionCredential', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const findingId = new Types.ObjectId().toHexString();
  const detectionId = new Types.ObjectId().toHexString();
  const repositoryId = new Types.ObjectId();

  function buildFindingModel() {
    return {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ _id: findingId, repositoryId }),
      }),
    };
  }

  function buildDetectionModel(detection: Record<string, unknown>) {
    const doc: Record<string, unknown> & { save: jest.Mock } = {
      ...detection,
      save: jest.fn().mockResolvedValue(undefined),
    };
    return {
      findOne: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) }),
      __doc: doc,
    };
  }

  function buildRepoModel(
    repo: Record<string, unknown> | null = { owner: 'someone', name: 'repo' },
  ) {
    return {
      findById: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(repo),
      }),
    };
  }

  it('marks non-exposed-secret detections unsupported without touching GitHub', async () => {
    const detectionModel = buildDetectionModel({
      category: ThreatCategory.BRAND_IMPERSONATION,
      ruleId: 'brand-impersonation',
    });
    const github = { getSmallTextFile: jest.fn() };
    const service = new FindingsService(
      buildFindingModel() as never,
      detectionModel as never,
      buildRepoModel() as never,
      {} as never,
      {} as never,
      github as never,
      {} as never,
    );

    const result = await service.verifyDetectionCredential(
      workspaceId,
      findingId,
      detectionId,
    );
    expect(result.status).toBe('unsupported');
    expect(github.getSmallTextFile).not.toHaveBeenCalled();
    expect(detectionModel.__doc.save).toHaveBeenCalled();
    expect(detectionModel.__doc.verification).toEqual(result);
  });

  it('marks historical (commit-scan) detections unsupported without re-fetching', async () => {
    const detectionModel = buildDetectionModel({
      category: ThreatCategory.EXPOSED_SECRET,
      ruleId: 'secret-github-pat',
      file: 'history/abc1234/config.env',
    });
    const github = { getSmallTextFile: jest.fn() };
    const service = new FindingsService(
      buildFindingModel() as never,
      detectionModel as never,
      buildRepoModel() as never,
      {} as never,
      {} as never,
      github as never,
      {} as never,
    );

    const result = await service.verifyDetectionCredential(
      workspaceId,
      findingId,
      detectionId,
    );
    expect(result.status).toBe('unsupported');
    expect(github.getSmallTextFile).not.toHaveBeenCalled();
  });

  it('reports invalid (likely rotated) when the pattern no longer appears in the re-fetched file', async () => {
    const detectionModel = buildDetectionModel({
      category: ThreatCategory.EXPOSED_SECRET,
      ruleId: 'secret-github-pat',
      file: 'config.env',
    });
    const github = {
      getSmallTextFile: jest
        .fn()
        .mockResolvedValue('# nothing secret here anymore'),
    };
    const service = new FindingsService(
      buildFindingModel() as never,
      detectionModel as never,
      buildRepoModel() as never,
      {} as never,
      {} as never,
      github as never,
      {} as never,
    );

    const result = await service.verifyDetectionCredential(
      workspaceId,
      findingId,
      detectionId,
    );
    expect(result.status).toBe('invalid');
    expect(result.detail).toContain('rotated');
  });

  it('re-fetches the file, re-extracts the raw secret, and calls the credential verifier with it', async () => {
    const detectionModel = buildDetectionModel({
      category: ThreatCategory.EXPOSED_SECRET,
      ruleId: 'secret-github-pat',
      file: 'config.env',
    });
    const github = {
      getSmallTextFile: jest
        .fn()
        .mockResolvedValue('TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
    };
    const verify = jest.fn().mockResolvedValue({
      status: 'active',
      detail: 'GitHub confirms this token is active.',
      checkedAt: new Date(),
    });
    const service = new FindingsService(
      buildFindingModel() as never,
      detectionModel as never,
      buildRepoModel() as never,
      {} as never,
      {} as never,
      github as never,
      { verify } as never,
    );

    const result = await service.verifyDetectionCredential(
      workspaceId,
      findingId,
      detectionId,
    );
    expect(verify).toHaveBeenCalledWith(
      'secret-github-pat',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(result.status).toBe('active');
    expect(detectionModel.__doc.verification).toEqual(result);
  });

  it('reports invalid when the file no longer exists (secret likely already removed)', async () => {
    const detectionModel = buildDetectionModel({
      category: ThreatCategory.EXPOSED_SECRET,
      ruleId: 'secret-github-pat',
      file: 'config.env',
    });
    const github = { getSmallTextFile: jest.fn().mockResolvedValue(null) };
    const service = new FindingsService(
      buildFindingModel() as never,
      detectionModel as never,
      buildRepoModel() as never,
      {} as never,
      {} as never,
      github as never,
      {} as never,
    );

    const result = await service.verifyDetectionCredential(
      workspaceId,
      findingId,
      detectionId,
    );
    expect(result.status).toBe('invalid');
    expect(result.detail).toContain('removed');
  });

  it('never sends the raw secret value anywhere except the verifier call itself', async () => {
    const detectionModel = buildDetectionModel({
      category: ThreatCategory.EXPOSED_SECRET,
      ruleId: 'secret-github-pat',
      file: 'config.env',
    });
    const rawSecret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const github = {
      getSmallTextFile: jest.fn().mockResolvedValue(`TOKEN=${rawSecret}`),
    };
    const verify = jest.fn().mockResolvedValue({
      status: 'active',
      detail: 'GitHub confirms this token is active.',
      checkedAt: new Date(),
    });
    const service = new FindingsService(
      buildFindingModel() as never,
      detectionModel as never,
      buildRepoModel() as never,
      {} as never,
      {} as never,
      github as never,
      { verify } as never,
    );

    const result = await service.verifyDetectionCredential(
      workspaceId,
      findingId,
      detectionId,
    );
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(detectionModel.__doc.verification)).not.toContain(
      rawSecret,
    );
  });
});
