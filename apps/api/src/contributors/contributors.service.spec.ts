import { Types } from 'mongoose';
import { ContributorsService } from './contributors.service';

function buildAggregateSpy(dataRows: unknown[], total: number) {
  return jest
    .fn()
    .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(dataRows) })
    .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue([{ total }]) });
}

describe('ContributorsService.list', () => {
  it('returns contributors with their repo roster and no company when repos have no discoveryBrandId', async () => {
    const repoId = new Types.ObjectId();
    const aggregateSpy = buildAggregateSpy(
      [
        {
          _id: 'shared-dev',
          avatarUrl: 'https://x/a.png',
          totalRepositories: 1,
          repositories: [
            {
              repositoryId: repoId,
              fullName: 'owner/repo',
              owner: 'owner',
              contributions: 5,
            },
          ],
        },
      ],
      1,
    );
    const contributorModel = { aggregate: aggregateSpy };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockResolvedValue([{ _id: repoId, discoveryBrandId: null }]),
      }),
    };
    const brandModel = { find: jest.fn() };

    const service = new ContributorsService(
      contributorModel as never,
      repoModel as never,
      brandModel as never,
    );

    const result = await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
    });

    expect(result.total).toBe(1);
    expect(result.data).toEqual([
      {
        login: 'shared-dev',
        avatarUrl: 'https://x/a.png',
        totalRepositories: 1,
        companies: [],
        repositories: [
          {
            repositoryId: String(repoId),
            fullName: 'owner/repo',
            owner: 'owner',
            contributions: 5,
            company: undefined,
          },
        ],
      },
    ]);
    expect(brandModel.find).not.toHaveBeenCalled();
  });

  it('resolves company names via a batched Repository + MonitoredBrand lookup', async () => {
    const repoId = new Types.ObjectId();
    const brandId = new Types.ObjectId();
    const aggregateSpy = buildAggregateSpy(
      [
        {
          _id: 'shared-dev',
          totalRepositories: 1,
          repositories: [
            {
              repositoryId: repoId,
              fullName: 'owner/repo',
              owner: 'owner',
              contributions: 5,
            },
          ],
        },
      ],
      1,
    );
    const contributorModel = { aggregate: aggregateSpy };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockResolvedValue([{ _id: repoId, discoveryBrandId: brandId }]),
      }),
    };
    const brandModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([{ _id: brandId, name: 'Zerodha' }]),
      }),
    };

    const service = new ContributorsService(
      contributorModel as never,
      repoModel as never,
      brandModel as never,
    );

    const result = await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
    });

    expect(result.data[0].companies).toEqual(['Zerodha']);
    expect(result.data[0].repositories[0].company).toBe('Zerodha');
  });

  it('restricts to logins with a repo under the given company, before grouping their full roster', async () => {
    const companyRepoId = new Types.ObjectId();
    const brandId = new Types.ObjectId().toHexString();
    const aggregateSpy = buildAggregateSpy([], 0);
    const contributorModel = {
      aggregate: aggregateSpy,
      find: jest.fn().mockReturnValue({
        distinct: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(['shared-dev']),
        }),
      }),
    };
    const repoModel = {
      find: jest.fn().mockReturnValue({
        distinct: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([companyRepoId]),
        }),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const brandModel = { find: jest.fn() };

    const service = new ContributorsService(
      contributorModel as never,
      repoModel as never,
      brandModel as never,
    );

    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      companyId: brandId,
    });

    const dataPipeline = aggregateSpy.mock.calls[0][0] as Array<{
      $match?: { login?: { $in: string[] } };
    }>;
    expect(dataPipeline[0].$match?.login).toEqual({ $in: ['shared-dev'] });
  });

  it('adds a case-insensitive login regex stage when search is given', async () => {
    const aggregateSpy = buildAggregateSpy([], 0);
    const contributorModel = { aggregate: aggregateSpy };
    const repoModel = { find: jest.fn() };
    const brandModel = { find: jest.fn() };

    const service = new ContributorsService(
      contributorModel as never,
      repoModel as never,
      brandModel as never,
    );

    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      search: 'shared',
    });

    const dataPipeline = aggregateSpy.mock.calls[0][0] as Array<{
      $match?: { _id?: { $regex: string; $options: string } };
    }>;
    const searchStage = dataPipeline.find((s) => s.$match?._id);
    expect(searchStage?.$match?._id).toEqual({
      $regex: 'shared',
      $options: 'i',
    });
  });

  it('adds a totalRepositories $gte stage when minRepositories is given', async () => {
    const aggregateSpy = buildAggregateSpy([], 0);
    const contributorModel = { aggregate: aggregateSpy };
    const repoModel = { find: jest.fn() };
    const brandModel = { find: jest.fn() };

    const service = new ContributorsService(
      contributorModel as never,
      repoModel as never,
      brandModel as never,
    );

    await service.list({
      workspaceId: new Types.ObjectId().toHexString(),
      minRepositories: 2,
    });

    const dataPipeline = aggregateSpy.mock.calls[0][0] as Array<{
      $match?: { totalRepositories?: { $gte: number } };
    }>;
    const havingStage = dataPipeline.find((s) => s.$match?.totalRepositories);
    expect(havingStage?.$match?.totalRepositories).toEqual({ $gte: 2 });
  });
});
