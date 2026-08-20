import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import {
  RepositoryContributor,
  RepositoryContributorDocument,
} from '../repositories/schemas/repository-contributor.schema';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../brands/schemas/monitored-brand.schema';

export interface ContributorFilters {
  workspaceId: string;
  search?: string;
  /** MonitoredBrand _id - only contributors with at least one repo discovered for this company. */
  companyId?: string;
  /** Only contributors who've contributed to at least this many distinct repos in the workspace. */
  minRepositories?: number;
  sortBy?: 'totalRepositories' | 'login';
  page?: number;
  limit?: number;
}

export interface ContributorRepoSummary {
  repositoryId: string;
  fullName: string;
  owner: string;
  contributions: number;
  /** The company (MonitoredBrand) this repo was discovered for, if any. */
  company?: string;
}

export interface ContributorSummary {
  login: string;
  avatarUrl?: string;
  totalRepositories: number;
  /** Every distinct company across this contributor's own repos. */
  companies: string[];
  repositories: ContributorRepoSummary[];
}

interface ContributorGroupRow {
  _id: string;
  avatarUrl?: string;
  totalRepositories: number;
  repositories: Array<{
    repositoryId: Types.ObjectId;
    fullName: string;
    owner: string;
    contributions: number;
  }>;
}

@Injectable()
export class ContributorsService {
  constructor(
    @InjectModel(RepositoryContributor.name)
    private readonly contributorModel: Model<RepositoryContributorDocument>,
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
  ) {}

  async list(filters: ContributorFilters): Promise<{
    data: ContributorSummary[];
    total: number;
    page: number;
    limit: number;
  }> {
    const workspaceId = new Types.ObjectId(filters.workspaceId);
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const matchStage: Record<string, unknown> = { workspaceId };
    // Company filter narrows WHICH LOGINS qualify (contributed to at least
    // one repo discovered for this company) without narrowing which repos
    // show up for them once they qualify - the group stage below still
    // pulls every repo for a qualifying login, not just this company's.
    if (filters.companyId && Types.ObjectId.isValid(filters.companyId)) {
      const companyRepoIds = await this.repoModel
        .find({
          workspaceId,
          discoveryBrandId: new Types.ObjectId(filters.companyId),
        })
        .distinct('_id')
        .exec();
      const qualifyingLogins = await this.contributorModel
        .find({ workspaceId, repositoryId: { $in: companyRepoIds } })
        .distinct('login')
        .exec();
      matchStage.login = { $in: qualifyingLogins };
    }

    const groupPipeline: PipelineStage[] = [
      { $match: matchStage },
      {
        $group: {
          _id: '$login',
          avatarUrl: { $first: '$avatarUrl' },
          totalRepositories: { $sum: 1 },
          repositories: {
            $push: {
              repositoryId: '$repositoryId',
              fullName: '$fullName',
              owner: '$owner',
              contributions: '$contributions',
            },
          },
        },
      },
    ];
    if (filters.search) {
      groupPipeline.push({
        $match: { _id: { $regex: filters.search, $options: 'i' } },
      });
    }
    if (filters.minRepositories) {
      groupPipeline.push({
        $match: { totalRepositories: { $gte: filters.minRepositories } },
      });
    }
    const sortStage: PipelineStage =
      filters.sortBy === 'login'
        ? { $sort: { _id: 1 } }
        : { $sort: { totalRepositories: -1, _id: 1 } };

    const [rows, totalRows] = await Promise.all([
      this.contributorModel
        .aggregate<ContributorGroupRow>([
          ...groupPipeline,
          sortStage,
          { $skip: skip },
          { $limit: limit },
        ])
        .exec(),
      this.contributorModel
        .aggregate<{ total: number }>([...groupPipeline, { $count: 'total' }])
        .exec(),
    ]);
    const total = totalRows[0]?.total || 0;

    const repoBrandById = await this.resolveCompaniesForRepos(
      workspaceId,
      rows.flatMap((r) => r.repositories.map((x) => x.repositoryId)),
    );

    const data: ContributorSummary[] = rows.map((r) => {
      const repositories: ContributorRepoSummary[] = r.repositories.map(
        (x) => ({
          repositoryId: String(x.repositoryId),
          fullName: x.fullName,
          owner: x.owner,
          contributions: x.contributions,
          company: repoBrandById.get(String(x.repositoryId)),
        }),
      );
      return {
        login: r._id,
        avatarUrl: r.avatarUrl,
        totalRepositories: r.totalRepositories,
        companies: [
          ...new Set(
            repositories.map((x) => x.company).filter((c): c is string => !!c),
          ),
        ],
        repositories,
      };
    });

    return { data, total, page, limit };
  }

  /**
   * Batched repositoryId -> company name resolution, mirroring
   * ScansService.attachMatchInfo's batch-then-map pattern: one Repository
   * query, one MonitoredBrand query, then an in-memory lookup - never a
   * per-row join.
   */
  private async resolveCompaniesForRepos(
    workspaceId: Types.ObjectId,
    repositoryIds: Types.ObjectId[],
  ): Promise<Map<string, string>> {
    const repoBrandById = new Map<string, string>();
    const uniqueRepoIds = [
      ...new Set(repositoryIds.map((id) => String(id))),
    ].map((id) => new Types.ObjectId(id));
    if (uniqueRepoIds.length === 0) return repoBrandById;

    const repos = await this.repoModel
      .find({ workspaceId, _id: { $in: uniqueRepoIds } })
      .select('discoveryBrandId')
      .lean()
      .exec();
    const brandIds = [
      ...new Set(
        repos
          .map((r) => r.discoveryBrandId)
          .filter((id): id is Types.ObjectId => !!id)
          .map(String),
      ),
    ].map((id) => new Types.ObjectId(id));
    if (brandIds.length === 0) return repoBrandById;

    const brands = await this.brandModel
      .find({ _id: { $in: brandIds } })
      .select('name')
      .lean()
      .exec();
    const brandNameById = new Map(brands.map((b) => [String(b._id), b.name]));

    for (const r of repos) {
      if (!r.discoveryBrandId) continue;
      const name = brandNameById.get(String(r.discoveryBrandId));
      if (name) repoBrandById.set(String(r._id), name);
    }
    return repoBrandById;
  }
}
