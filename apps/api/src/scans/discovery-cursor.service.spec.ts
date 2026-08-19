import { Types } from 'mongoose';
import { DiscoveryCursorService } from './discovery-cursor.service';

function buildService(overrides: {
  findOneResult?: unknown;
  updateOneMock?: jest.Mock;
}) {
  const updateOne =
    overrides.updateOneMock ||
    jest.fn().mockReturnValue({
      exec: () => Promise.resolve({}),
    });
  const cursorModel = {
    findOne: jest.fn().mockReturnValue({
      lean: () => ({
        exec: () => Promise.resolve(overrides.findOneResult ?? null),
      }),
    }),
    updateOne,
  };
  return {
    service: new DiscoveryCursorService(cursorModel as never),
    cursorModel,
  };
}

describe('DiscoveryCursorService', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  describe('getResumePage', () => {
    it('returns 1 when no cursor exists yet for this query', async () => {
      const { service } = buildService({ findOneResult: null });
      const page = await service.getResumePage(
        workspaceId,
        'repositories',
        '"zerodha" login verify',
      );
      expect(page).toBe(1);
    });

    it('returns lastPage + 1 when a non-exhausted cursor exists', async () => {
      const { service } = buildService({
        findOneResult: { lastPage: 4, exhausted: false },
      });
      const page = await service.getResumePage(
        workspaceId,
        'repositories',
        '"zerodha" login verify',
      );
      expect(page).toBe(5);
    });

    it('restarts at page 1 once the query has been marked exhausted (nothing further back to fetch)', async () => {
      const { service } = buildService({
        findOneResult: { lastPage: 10, exhausted: true },
      });
      const page = await service.getResumePage(
        workspaceId,
        'repositories',
        '"zerodha" login verify',
      );
      expect(page).toBe(1);
    });

    it('scopes the lookup by workspace, kind, and a hash of the exact query text', async () => {
      const { service, cursorModel } = buildService({ findOneResult: null });
      await service.getResumePage(workspaceId, 'code', 'org:evil "zerodha"');
      expect(cursorModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'code',
          queryHash: expect.any(String),
        }),
      );
    });
  });

  describe('saveCursor', () => {
    it('upserts the cursor with the completed page and exhausted flag', async () => {
      const updateOneMock = jest.fn().mockReturnValue({
        exec: () => Promise.resolve({}),
      });
      const { service } = buildService({ updateOneMock });
      await service.saveCursor(
        workspaceId,
        'repositories',
        '"zerodha" login verify',
        3,
        false,
      );
      expect(updateOneMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'repositories',
          queryHash: expect.any(String),
        }),
        {
          $set: {
            query: '"zerodha" login verify',
            lastPage: 3,
            exhausted: false,
          },
        },
        { upsert: true },
      );
    });

    it('produces the same queryHash for the same (kind, query) pair across separate calls, so reads find what writes stored', async () => {
      const { service, cursorModel } = buildService({ findOneResult: null });
      await service.saveCursor(
        workspaceId,
        'repositories',
        'same query',
        2,
        false,
      );
      await service.getResumePage(workspaceId, 'repositories', 'same query');
      const savedHash = (
        cursorModel.updateOne.mock.calls[0][0] as { queryHash: string }
      ).queryHash;
      const lookedUpHash = (
        cursorModel.findOne.mock.calls[0][0] as { queryHash: string }
      ).queryHash;
      expect(savedHash).toBe(lookedUpHash);
    });

    it('produces a different queryHash for a different query, even for the same workspace/kind', async () => {
      const { cursorModel } = buildService({ findOneResult: null });
      const service = new DiscoveryCursorService(cursorModel as never);
      await service.saveCursor(
        workspaceId,
        'repositories',
        'query A',
        1,
        false,
      );
      await service.saveCursor(
        workspaceId,
        'repositories',
        'query B',
        1,
        false,
      );
      const [hashA, hashB] = cursorModel.updateOne.mock.calls.map(
        (call) => (call[0] as { queryHash: string }).queryHash,
      );
      expect(hashA).not.toBe(hashB);
    });
  });
});
