import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

jest.mock('./git-repo.util', () => ({
  buildCloneUrl: jest.fn(
    (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  ),
  cloneShallow: jest.fn(),
  listTree: jest.fn(),
  checkoutPaths: jest.fn(),
  getHeadSha: jest.fn(),
  isGitAvailable: jest.fn(),
  readFileCapped: jest.fn(),
}));

import {
  buildCloneUrl,
  checkoutPaths,
  cloneShallow,
  getHeadSha,
  isGitAvailable,
  listTree,
  readFileCapped,
} from './git-repo.util';
import { ReferenceFingerprintService } from './reference-fingerprint.service';

const gitUtil = {
  buildCloneUrl: buildCloneUrl as jest.Mock,
  cloneShallow: cloneShallow as jest.Mock,
  listTree: listTree as jest.Mock,
  checkoutPaths: checkoutPaths as jest.Mock,
  getHeadSha: getHeadSha as jest.Mock,
  isGitAvailable: isGitAvailable as jest.Mock,
  readFileCapped: readFileCapped as jest.Mock,
};

function buildConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = { ...overrides };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const workspaceId = new Types.ObjectId().toHexString();
const brandId = new Types.ObjectId().toHexString();

function buildModels() {
  const fingerprintModel = {
    updateOne: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    aggregate: jest.fn().mockResolvedValue([]),
  };
  const contentStringModel = {
    updateOne: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
  const knownSecretModel = {
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const brandModel = {
    exists: jest
      .fn()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue({ _id: brandId }) }),
  };
  return { fingerprintModel, contentStringModel, knownSecretModel, brandModel };
}

function buildService(
  models: ReturnType<typeof buildModels>,
  config = buildConfig(),
) {
  return new ReferenceFingerprintService(
    models.fingerprintModel as never,
    models.contentStringModel as never,
    models.knownSecretModel as never,
    models.brandModel as never,
    config,
  );
}

describe('ReferenceFingerprintService.ingestReferenceRepo', () => {
  afterEach(() => jest.clearAllMocks());

  it('throws NotFoundException when the brand does not belong to the workspace', async () => {
    const models = buildModels();
    models.brandModel.exists.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    const service = buildService(models);

    await expect(
      service.ingestReferenceRepo(workspaceId, brandId, 'acme', 'demo'),
    ).rejects.toThrow(NotFoundException);
    expect(gitUtil.cloneShallow).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for a malformed brandId without touching the DB', async () => {
    const models = buildModels();
    const service = buildService(models);
    await expect(
      service.ingestReferenceRepo(
        workspaceId,
        'not-an-object-id',
        'acme',
        'demo',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(models.brandModel.exists).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailableException when git is not available', async () => {
    const models = buildModels();
    gitUtil.isGitAvailable.mockResolvedValue(false);
    const service = buildService(models);
    await expect(
      service.ingestReferenceRepo(workspaceId, brandId, 'acme', 'demo'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws BadRequestException when the clone fails, and still cleans up', async () => {
    const models = buildModels();
    gitUtil.isGitAvailable.mockResolvedValue(true);
    gitUtil.cloneShallow.mockRejectedValue(new Error('exited with code 128'));
    const service = buildService(models);
    await expect(
      service.ingestReferenceRepo(workspaceId, brandId, 'acme', 'missing'),
    ).rejects.toThrow(BadRequestException);
  });

  it('ingests eligible files, excludes vendored dirs, and drops stale fingerprints', async () => {
    const models = buildModels();
    gitUtil.isGitAvailable.mockResolvedValue(true);
    gitUtil.cloneShallow.mockResolvedValue(undefined);
    gitUtil.listTree.mockResolvedValue([
      'src/index.ts',
      'src/login.tsx',
      'node_modules/dep/index.js',
      'binary.png',
    ]);
    gitUtil.checkoutPaths.mockResolvedValue(undefined);
    gitUtil.getHeadSha.mockResolvedValue('a1b2c3d4');
    gitUtil.readFileCapped.mockImplementation((absPath: string) => {
      if (absPath.includes('binary.png')) return Promise.resolve(null); // simulates binary/oversized skip
      if (absPath.includes('index.ts'))
        return Promise.resolve('export const x = 1;');
      if (absPath.includes('login.tsx'))
        return Promise.resolve('export function Login() { return null; }');
      return Promise.resolve(null);
    });

    const service = buildService(models);
    const result = await service.ingestReferenceRepo(
      workspaceId,
      brandId,
      'acme',
      'frontend',
    );

    // node_modules must never reach checkout - proof exclusion happens
    // before selection, not just post-hoc filtering.
    const checkoutCalls = gitUtil.checkoutPaths.mock.calls as Array<
      [string, string[], number]
    >;
    const checkedOutPaths = checkoutCalls.flatMap((c) => c[1]);
    expect(checkedOutPaths).not.toContain('node_modules/dep/index.js');
    expect(checkedOutPaths).toEqual(
      expect.arrayContaining(['src/index.ts', 'src/login.tsx', 'binary.png']),
    );

    expect(models.fingerprintModel.updateOne).toHaveBeenCalledTimes(2);
    const updateOneCalls = models.fingerprintModel.updateOne.mock
      .calls as Array<
      [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
        Record<string, unknown>,
      ]
    >;
    const [filter, update, opts] = updateOneCalls[0];
    expect(filter).toMatchObject({
      sourceOwner: 'acme',
      sourceRepo: 'frontend',
    });
    expect(update.$set).toHaveProperty('contentHash');
    expect(update.$set).toHaveProperty('chunkHashes');
    expect(update.$set.commitSha).toBe('a1b2c3d4');
    expect(opts).toEqual({ upsert: true });

    expect(models.fingerprintModel.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOwner: 'acme',
        sourceRepo: 'frontend',
        filePath: { $nin: ['src/index.ts', 'src/login.tsx'] },
      }),
    );

    // Neither ingested file is content-bearing (both are plain .ts/.tsx
    // source, not locale/template/legal/docs) and neither contains a
    // recognizable secret pattern, so no bait strings or secret hashes
    // should have been stored for this run.
    expect(models.contentStringModel.updateOne).not.toHaveBeenCalled();
    expect(models.knownSecretModel.updateOne).not.toHaveBeenCalled();

    expect(result).toEqual({
      owner: 'acme',
      repo: 'frontend',
      commitSha: 'a1b2c3d4',
      totalTreeFiles: 3, // node_modules excluded before this count
      filesIngested: 2,
      filesSkipped: 1,
      truncatedByFileCap: false,
      distinctivePhrasesStored: 0,
      knownSecretsStored: 0,
    });
  });

  it('extracts and stores distinctive phrases only from content-bearing files', async () => {
    const models = buildModels();
    gitUtil.isGitAvailable.mockResolvedValue(true);
    gitUtil.cloneShallow.mockResolvedValue(undefined);
    gitUtil.listTree.mockResolvedValue(['src/locales/en.json', 'src/index.ts']);
    gitUtil.checkoutPaths.mockResolvedValue(undefined);
    gitUtil.getHeadSha.mockResolvedValue('sha1');
    gitUtil.readFileCapped.mockImplementation((absPath: string) => {
      if (absPath.includes('en.json')) {
        return Promise.resolve(
          '{"welcome": "Track your shipment in real time with Acme Express nationwide"}',
        );
      }
      // Same word-count-worthy phrase, but in a non-content file - must be ignored.
      if (absPath.includes('index.ts')) {
        return Promise.resolve(
          '// Track your shipment in real time with Acme Express nationwide\nexport const x = 1;',
        );
      }
      return Promise.resolve(null);
    });

    const service = buildService(models);
    const result = await service.ingestReferenceRepo(
      workspaceId,
      brandId,
      'acme',
      'web',
    );

    expect(models.contentStringModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = models.contentStringModel.updateOne.mock
      .calls[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(filter).toMatchObject({
      sourceOwner: 'acme',
      sourceRepo: 'web',
      filePath: 'src/locales/en.json',
      text: 'Track your shipment in real time with Acme Express nationwide',
    });
    expect(update.$set.category).toBe('locale');
    expect(result.distinctivePhrasesStored).toBe(1);
  });

  it('extracts and stores a hash-only known-secret entry, never the raw value', async () => {
    const models = buildModels();
    const rawKey = 'AKIAIOSFODNN7EXAMPLE';
    gitUtil.isGitAvailable.mockResolvedValue(true);
    gitUtil.cloneShallow.mockResolvedValue(undefined);
    gitUtil.listTree.mockResolvedValue(['.env']);
    gitUtil.checkoutPaths.mockResolvedValue(undefined);
    gitUtil.getHeadSha.mockResolvedValue('sha1');
    gitUtil.readFileCapped.mockResolvedValue(`AWS_ACCESS_KEY_ID=${rawKey}`);

    const service = buildService(models);
    const result = await service.ingestReferenceRepo(
      workspaceId,
      brandId,
      'acme',
      'infra',
    );

    expect(models.knownSecretModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = models.knownSecretModel.updateOne.mock
      .calls[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(filter).toMatchObject({
      valueHash: createHash('sha256').update(rawKey, 'utf8').digest('hex'),
    });
    expect(JSON.stringify(filter)).not.toContain(rawKey);
    expect(JSON.stringify(update)).not.toContain(rawKey);
    expect(update.$set.patternId).toBe('secret-aws-access-key');
    expect(result.knownSecretsStored).toBe(1);
  });

  it('truncates to REFERENCE_INGEST_MAX_FILES and reports truncation', async () => {
    const models = buildModels();
    gitUtil.isGitAvailable.mockResolvedValue(true);
    gitUtil.cloneShallow.mockResolvedValue(undefined);
    gitUtil.listTree.mockResolvedValue(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    gitUtil.checkoutPaths.mockResolvedValue(undefined);
    gitUtil.getHeadSha.mockResolvedValue('sha1');
    gitUtil.readFileCapped.mockResolvedValue('content');

    const service = buildService(
      models,
      buildConfig({ REFERENCE_INGEST_MAX_FILES: '2' }),
    );
    const result = await service.ingestReferenceRepo(
      workspaceId,
      brandId,
      'acme',
      'big',
    );
    expect(result.truncatedByFileCap).toBe(true);
    expect(result.filesIngested).toBe(2);
    expect(result.totalTreeFiles).toBe(4);
  });

  it('embeds the configured GitHub token when building the clone URL', async () => {
    const models = buildModels();
    gitUtil.isGitAvailable.mockResolvedValue(true);
    gitUtil.cloneShallow.mockResolvedValue(undefined);
    gitUtil.listTree.mockResolvedValue([]);
    gitUtil.getHeadSha.mockResolvedValue('sha1');

    const service = buildService(
      models,
      buildConfig({ GITHUB_TOKEN: 'ghp_abc' }),
    );
    await service.ingestReferenceRepo(
      workspaceId,
      brandId,
      'acme',
      'private-repo',
    );
    expect(gitUtil.buildCloneUrl).toHaveBeenCalledWith(
      'acme',
      'private-repo',
      'ghp_abc',
    );
  });
});

describe('ReferenceFingerprintService.listReferenceRepos', () => {
  afterEach(() => jest.clearAllMocks());

  it('maps and sorts aggregated reference repos', async () => {
    const models = buildModels();
    models.fingerprintModel.aggregate.mockResolvedValue([
      {
        _id: { sourceOwner: 'acme', sourceRepo: 'zebra' },
        fileCount: 10,
        commitSha: 'sha-z',
        lastIngestedAt: new Date('2026-01-02'),
      },
      {
        _id: { sourceOwner: 'acme', sourceRepo: 'alpha' },
        fileCount: 5,
        commitSha: 'sha-a',
        lastIngestedAt: new Date('2026-01-01'),
      },
    ]);
    const service = buildService(models);
    const rows = await service.listReferenceRepos(workspaceId, brandId);
    expect(rows.map((r) => r.repo)).toEqual(['alpha', 'zebra']);
    expect(rows[0]).toMatchObject({
      owner: 'acme',
      fileCount: 5,
      commitSha: 'sha-a',
    });
  });
});

describe('ReferenceFingerprintService.removeReferenceRepo', () => {
  afterEach(() => jest.clearAllMocks());

  it('throws NotFoundException when nothing was deleted', async () => {
    const models = buildModels();
    models.fingerprintModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
    const service = buildService(models);
    await expect(
      service.removeReferenceRepo(workspaceId, brandId, 'acme', 'ghost'),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns the deleted count on success and also clears content-string bait', async () => {
    const models = buildModels();
    models.fingerprintModel.deleteMany.mockResolvedValue({ deletedCount: 12 });
    const service = buildService(models);
    await expect(
      service.removeReferenceRepo(workspaceId, brandId, 'acme', 'demo'),
    ).resolves.toEqual({ deletedCount: 12 });
    expect(models.contentStringModel.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ sourceOwner: 'acme', sourceRepo: 'demo' }),
    );
  });
});
