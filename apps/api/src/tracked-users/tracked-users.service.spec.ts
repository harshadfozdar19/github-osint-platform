import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { TrackedUsersService } from './tracked-users.service';

describe('TrackedUsersService', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  describe('add', () => {
    it('rejects a username already tracked in this workspace, case-insensitively', async () => {
      const trackedModel = {
        findOne: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue({ username: 'Octocat' }),
        }),
        create: jest.fn(),
      };
      const service = new TrackedUsersService(trackedModel as never);

      await expect(service.add(workspaceId, 'octoCAT')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(trackedModel.create).not.toHaveBeenCalled();
      // Looked up by the lowercased form, regardless of the casing typed in.
      const findOneCall = trackedModel.findOne.mock.calls[0][0] as {
        usernameLower: string;
      };
      expect(findOneCall.usernameLower).toBe('octocat');
    });

    it('creates a new tracked user with a lowercased dedup key and a trimmed note', async () => {
      const trackedModel = {
        findOne: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(null),
        }),
        create: jest.fn().mockResolvedValue({ username: 'octocat' }),
      };
      const service = new TrackedUsersService(trackedModel as never);

      await service.add(
        workspaceId,
        'octocat',
        '  found via a fake-apk repo  ',
      );

      expect(trackedModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'octocat',
          usernameLower: 'octocat',
          note: 'found via a fake-apk repo',
        }),
      );
    });
  });

  describe('remove', () => {
    it('throws NotFoundException for a malformed id', async () => {
      const trackedModel = { deleteOne: jest.fn() };
      const service = new TrackedUsersService(trackedModel as never);

      await expect(
        service.remove(workspaceId, 'not-an-object-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(trackedModel.deleteOne).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when nothing matched (wrong workspace or already removed)', async () => {
      const trackedModel = {
        deleteOne: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({ deletedCount: 0 }),
        }),
      };
      const service = new TrackedUsersService(trackedModel as never);

      await expect(
        service.remove(workspaceId, new Types.ObjectId().toHexString()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('succeeds when exactly one document matched', async () => {
      const trackedModel = {
        deleteOne: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({ deletedCount: 1 }),
        }),
      };
      const service = new TrackedUsersService(trackedModel as never);

      await expect(
        service.remove(workspaceId, new Types.ObjectId().toHexString()),
      ).resolves.toBeUndefined();
    });
  });

  describe('commitSearchUrl', () => {
    it("builds GitHub's own author-scoped commit search, newest first", () => {
      expect(TrackedUsersService.commitSearchUrl('octocat')).toBe(
        'https://github.com/search?q=author%3Aoctocat&type=commits&s=committer-date&o=desc',
      );
    });
  });
});
