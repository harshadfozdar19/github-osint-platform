import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  TrackedGithubUser,
  TrackedGithubUserDocument,
} from './schemas/tracked-github-user.schema';

@Injectable()
export class TrackedUsersService {
  constructor(
    @InjectModel(TrackedGithubUser.name)
    private readonly trackedModel: Model<TrackedGithubUserDocument>,
  ) {}

  async list(workspaceId: string) {
    return this.trackedModel
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async add(workspaceId: string, username: string, note?: string) {
    const usernameLower = username.toLowerCase();
    const existing = await this.trackedModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        usernameLower,
      })
      .lean()
      .exec();
    if (existing) {
      throw new ConflictException(`"${username}" is already being tracked`);
    }
    return this.trackedModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      username,
      usernameLower,
      note: note?.trim() || '',
    });
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Tracked user not found');
    }
    const result = await this.trackedModel
      .deleteOne({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (result.deletedCount === 0) {
      throw new NotFoundException('Tracked user not found');
    }
  }

  /**
   * GitHub's own commit search, scoped to this one author, newest first -
   * this is the entire point of tracking someone: one click straight to
   * everything public they've committed, without this app ever calling
   * GitHub's API or storing any commit data itself.
   */
  static commitSearchUrl(username: string): string {
    const q = `author:${username}`;
    return `https://github.com/search?q=${encodeURIComponent(q)}&type=commits&s=committer-date&o=desc`;
  }
}
