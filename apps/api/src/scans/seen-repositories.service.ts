import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';

/**
 * A repo already known to a workspace (it has a Repository document there -
 * discovered by any prior scan or search) is "seen". By default, discovery
 * and ad-hoc search both hide already-seen repos so a workspace doesn't keep
 * getting shown the same repo it has already reviewed and made a call on.
 * `includeSeen` opts back in when the user genuinely wants to look again.
 */
@Injectable()
export class SeenRepositoriesService {
  constructor(
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
  ) {}

  /** Returns the subset of githubIds this workspace already has a record of. */
  async getSeenGithubIds(
    workspaceId: string,
    githubIds: number[],
  ): Promise<Set<number>> {
    if (githubIds.length === 0) return new Set();
    const docs = await this.repoModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        githubId: { $in: githubIds },
      })
      .select('githubId')
      .lean()
      .exec();
    return new Set(docs.map((d) => d.githubId));
  }

  /**
   * Filters a list of GitHub search-result-shaped items down to the ones not
   * already known to this workspace. Returns both the kept items and how
   * many were hidden, so callers can surface that count to the user instead
   * of silently shrinking the result set.
   */
  async filterUnseen<T extends { id: number }>(
    workspaceId: string,
    items: T[],
    includeSeen: boolean | undefined,
  ): Promise<{ items: T[]; hiddenSeenCount: number }> {
    if (includeSeen || items.length === 0) {
      return { items, hiddenSeenCount: 0 };
    }
    const seen = await this.getSeenGithubIds(
      workspaceId,
      items.map((i) => i.id),
    );
    if (seen.size === 0) return { items, hiddenSeenCount: 0 };
    const kept = items.filter((i) => !seen.has(i.id));
    return { items: kept, hiddenSeenCount: items.length - kept.length };
  }
}
