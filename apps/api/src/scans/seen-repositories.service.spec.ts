import { Types } from 'mongoose';
import { SeenRepositoriesService } from './seen-repositories.service';

describe('SeenRepositoriesService', () => {
  function build(seenGithubIds: number[]) {
    const repoModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockResolvedValue(seenGithubIds.map((githubId) => ({ githubId }))),
      }),
    };
    return {
      service: new SeenRepositoriesService(repoModel as never),
      repoModel,
    };
  }

  it('returns the empty set without querying when no ids are given', async () => {
    const { service, repoModel } = build([]);
    const seen = await service.getSeenGithubIds(
      new Types.ObjectId().toHexString(),
      [],
    );
    expect(seen.size).toBe(0);
    expect(repoModel.find).not.toHaveBeenCalled();
  });

  it('identifies which githubIds are already known to the workspace', async () => {
    const { service } = build([1, 2]);
    const seen = await service.getSeenGithubIds(
      new Types.ObjectId().toHexString(),
      [1, 2, 3],
    );
    expect(seen).toEqual(new Set([1, 2]));
  });

  it('filterUnseen passes everything through when includeSeen is true', async () => {
    const { service, repoModel } = build([1]);
    const items = [{ id: 1 }, { id: 2 }];
    const result = await service.filterUnseen(
      new Types.ObjectId().toHexString(),
      items,
      true,
    );
    expect(result).toEqual({ items, hiddenSeenCount: 0 });
    expect(repoModel.find).not.toHaveBeenCalled();
  });

  it('filterUnseen hides already-known repos by default', async () => {
    const { service } = build([1]);
    const items = [{ id: 1 }, { id: 2 }];
    const result = await service.filterUnseen(
      new Types.ObjectId().toHexString(),
      items,
      false,
    );
    expect(result.items).toEqual([{ id: 2 }]);
    expect(result.hiddenSeenCount).toBe(1);
  });

  it('filterUnseen is a no-op when nothing is already known', async () => {
    const { service } = build([]);
    const items = [{ id: 1 }, { id: 2 }];
    const result = await service.filterUnseen(
      new Types.ObjectId().toHexString(),
      items,
      undefined,
    );
    expect(result).toEqual({ items, hiddenSeenCount: 0 });
  });
});
