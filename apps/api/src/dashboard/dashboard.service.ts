import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import { Alert, AlertDocument } from '../alerts/schemas/alert.schema';
import { Severity } from '../common/enums';
import { GitHubService } from '../github/github.service';

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(Alert.name) private readonly alertModel: Model<AlertDocument>,
    private readonly github: GitHubService,
  ) {}

  async summary(workspaceId: string) {
    const ws = new Types.ObjectId(workspaceId);
    const [
      totalFindings,
      criticalFindings,
      highFindings,
      reposScanned,
      bySeverity,
      byCategory,
      overTime,
      recentCritical,
      unreadAlerts,
      githubRateLimit,
    ] = await Promise.all([
      this.findingModel.countDocuments({ workspaceId: ws }).exec(),
      this.findingModel
        .countDocuments({ workspaceId: ws, severity: Severity.CRITICAL })
        .exec(),
      this.findingModel
        .countDocuments({ workspaceId: ws, severity: Severity.HIGH })
        .exec(),
      this.repoModel.countDocuments({ workspaceId: ws }).exec(),
      this.findingModel.aggregate([
        { $match: { workspaceId: ws } },
        { $group: { _id: '$severity', count: { $sum: 1 } } },
      ]),
      this.findingModel.aggregate([
        { $match: { workspaceId: ws } },
        { $unwind: '$categories' },
        { $group: { _id: '$categories', count: { $sum: 1 } } },
      ]),
      this.findingModel.aggregate([
        { $match: { workspaceId: ws } },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 30 },
      ]),
      this.findingModel
        .find({
          workspaceId: ws,
          severity: { $in: [Severity.CRITICAL, Severity.HIGH] },
        })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('repositoryId')
        .lean()
        .exec(),
      this.alertModel.countDocuments({ workspaceId: ws, read: false }).exec(),
      this.github.getStatus(workspaceId).catch(() => null),
    ]);

    const bySeverityTyped = bySeverity as Array<{ _id: string; count: number }>;
    const byCategoryTyped = byCategory as Array<{ _id: string; count: number }>;
    const overTimeTyped = overTime as Array<{ _id: string; count: number }>;

    return {
      totalFindings,
      criticalFindings,
      highFindings,
      reposScanned,
      unreadAlerts,
      findingsBySeverity: bySeverityTyped.map((r) => ({
        severity: r._id,
        count: r.count,
      })),
      findingsByCategory: byCategoryTyped.map((r) => ({
        category: r._id,
        count: r.count,
      })),
      findingsOverTime: overTimeTyped.map((r) => ({
        date: r._id,
        count: r.count,
      })),
      recentCritical,
      githubRateLimit,
    };
  }
}
