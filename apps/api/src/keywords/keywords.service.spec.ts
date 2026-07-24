import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { KeywordsService } from './keywords.service';

describe('KeywordsService', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  let store: Array<Record<string, unknown>>;
  let service: KeywordsService;

  const keywordModel = {
    countDocuments: jest.fn(
      ({ workspaceId: ws }: { workspaceId: Types.ObjectId }) => ({
        exec: async () =>
          store.filter((k) => String(k.workspaceId) === String(ws)).length,
      }),
    ),
    find: jest.fn(({ workspaceId: ws }: { workspaceId: Types.ObjectId }) => ({
      sort: () => ({
        lean: () => ({
          exec: async () =>
            store
              .filter((k) => String(k.workspaceId) === String(ws))
              .sort((a, b) =>
                String(a.keyword).localeCompare(String(b.keyword)),
              ),
        }),
      }),
    })),
    findOne: jest.fn((query: Record<string, unknown>) => ({
      exec: async () =>
        store.find(
          (k) =>
            String(k.workspaceId) === String(query.workspaceId) &&
            (query.keyword
              ? k.keyword === query.keyword
              : String(k._id) === String(query._id)),
        ),
    })),
    create: jest.fn(async (doc: Record<string, unknown>) => {
      const created = { _id: new Types.ObjectId(), ...doc };
      store.push(created);
      return created;
    }),
    findOneAndUpdate: jest.fn(
      (
        query: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        exec: async () => {
          const idx = store.findIndex(
            (k) =>
              String(k._id) === String(query._id) &&
              String(k.workspaceId) === String(query.workspaceId),
          );
          if (idx < 0) return null;
          store[idx] = { ...store[idx], ...update.$set };
          return store[idx];
        },
      }),
    ),
    findOneAndDelete: jest.fn((query: Record<string, unknown>) => ({
      exec: async () => {
        const idx = store.findIndex(
          (k) =>
            String(k._id) === String(query._id) &&
            String(k.workspaceId) === String(query.workspaceId),
        );
        if (idx < 0) return null;
        const [deleted] = store.splice(idx, 1);
        return deleted;
      },
    })),
    insertMany: jest.fn(async (docs: Record<string, unknown>[]) => {
      for (const doc of docs) {
        store.push({ _id: new Types.ObjectId(), ...doc });
      }
    }),
  };

  beforeEach(() => {
    store = [];
    jest.clearAllMocks();
    service = new KeywordsService(keywordModel as never);
  });

  it('seeds defaults on first list', async () => {
    const rows = await service.list(workspaceId);
    expect(rows.length).toBeGreaterThan(20);
    expect(keywordModel.insertMany).toHaveBeenCalled();
  });

  it('creates a keyword', async () => {
    const created = await service.create(workspaceId, {
      keyword: 'wallet',
      category: 'phishing',
      priority: 8,
    });
    expect(created.keyword).toBe('wallet');
    expect(created.category).toBe('phishing');
  });

  it('rejects duplicate keywords', async () => {
    await service.create(workspaceId, { keyword: 'wallet' });
    await expect(
      service.create(workspaceId, { keyword: 'Wallet' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates and deletes keywords', async () => {
    const created = await service.create(workspaceId, { keyword: 'wallet' });
    const updated = await service.update(workspaceId, String(created._id), {
      priority: 10,
      enabled: false,
    });
    expect(updated.priority).toBe(10);
    expect(updated.enabled).toBe(false);

    const result = await service.remove(workspaceId, String(created._id));
    expect(result.success).toBe(true);
  });

  it('throws when keyword is missing', async () => {
    await expect(
      service.update(workspaceId, new Types.ObjectId().toHexString(), {
        priority: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
