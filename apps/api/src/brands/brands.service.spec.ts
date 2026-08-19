import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { BrandsService } from './brands.service';

describe('BrandsService', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  let store: Array<Record<string, unknown>>;
  let service: BrandsService;

  const brandModel = {
    countDocuments: jest.fn(
      ({ workspaceId: ws }: { workspaceId: Types.ObjectId }) => ({
        exec: async () =>
          store.filter((b) => String(b.workspaceId) === String(ws)).length,
      }),
    ),
    find: jest.fn(({ workspaceId: ws }: { workspaceId: Types.ObjectId }) => ({
      sort: () => ({
        lean: () => ({
          exec: async () =>
            store
              .filter((b) => String(b.workspaceId) === String(ws))
              .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        }),
      }),
    })),
    create: jest.fn(async (doc: Record<string, unknown>) => {
      const created = { _id: new Types.ObjectId(), ...doc };
      store.push(created);
      return created;
    }),
    findOneAndUpdate: jest.fn(
      (query: Record<string, unknown>, update: Record<string, unknown>) => {
        const idx = store.findIndex(
          (b) =>
            String(b._id) === String(query._id) &&
            String(b.workspaceId) === String(query.workspaceId),
        );
        if (idx >= 0) {
          if (update.$set) store[idx] = { ...store[idx], ...update.$set };
          else if (update.enabled !== undefined)
            store[idx] = { ...store[idx], enabled: update.enabled };
        }
        return {
          lean: () => ({ exec: async () => (idx < 0 ? null : store[idx]) }),
        };
      },
    ),
    findOneAndDelete: jest.fn((query: Record<string, unknown>) => ({
      exec: async () => {
        const idx = store.findIndex(
          (b) =>
            String(b._id) === String(query._id) &&
            String(b.workspaceId) === String(query.workspaceId),
        );
        if (idx < 0) return null;
        const [deleted] = store.splice(idx, 1);
        return deleted;
      },
    })),
    updateOne: jest.fn(async () => ({ upsertedCount: 1 })),
  };

  beforeEach(() => {
    store = [];
    jest.clearAllMocks();
    service = new BrandsService(brandModel as never);
  });

  it('creates, updates, and deletes a monitored brand', async () => {
    const created = await service.create(workspaceId, {
      name: 'FYND',
      aliases: ['fynd'],
      keywords: ['fynd'],
      enabled: true,
    });
    expect(created.name).toBe('FYND');

    const updated = await service.update(workspaceId, String(created._id), {
      description: 'Updated',
      enabled: false,
    });
    expect(updated.description).toBe('Updated');
    expect(updated.enabled).toBe(false);

    const result = await service.remove(workspaceId, String(created._id));
    expect(result.success).toBe(true);
  });

  it('toggles enabled state', async () => {
    const created = await service.create(workspaceId, { name: 'Acme' });
    const toggled = await service.setEnabled(
      workspaceId,
      String(created._id),
      false,
    );
    expect(toggled.enabled).toBe(false);
  });

  it('sets and updates trustedGithubOwners', async () => {
    const created = await service.create(workspaceId, {
      name: 'AngelOne',
      aliases: ['angelone'],
      trustedGithubOwners: ['angel-one-tech'],
    });
    expect(created.trustedGithubOwners).toEqual(['angel-one-tech']);

    const updated = await service.update(workspaceId, String(created._id), {
      trustedGithubOwners: ['angel-one-tech', 'angelone-official'],
    });
    expect(updated.trustedGithubOwners).toEqual([
      'angel-one-tech',
      'angelone-official',
    ]);
  });

  it('defaults trustedGithubOwners to an empty array when not given', async () => {
    const created = await service.create(workspaceId, { name: 'Acme' });
    expect(created.trustedGithubOwners).toEqual([]);
  });

  it('normalizes pasted GitHub URLs down to the bare owner login', async () => {
    const created = await service.create(workspaceId, {
      name: 'AngelOne',
      trustedGithubOwners: [
        'https://github.com/angel-one',
        'http://www.github.com/angel-one-tech/',
        'github.com/angelone-official/some-repo',
        '  already-bare  ',
      ],
    });
    expect(created.trustedGithubOwners).toEqual([
      'angel-one',
      'angel-one-tech',
      'angelone-official',
      'already-bare',
    ]);

    const updated = await service.update(workspaceId, String(created._id), {
      trustedGithubOwners: ['https://github.com/angel-one-updated'],
    });
    expect(updated.trustedGithubOwners).toEqual(['angel-one-updated']);
  });

  it('throws when brand is missing', async () => {
    await expect(
      service.update(workspaceId, new Types.ObjectId().toHexString(), {
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
