import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import {
  Detection,
  DetectionDocument,
} from '../detections/schemas/detection.schema';
import { IntentContext } from './providers/intent-provider.interface';

/**
 * Assembles the compact, structured context an intent-assessment call is
 * grounded in - deliberately built from what the deterministic rule engine
 * already extracted (Detection.evidence strings, brand match evidence),
 * never raw file dumps. Keeps token cost low and signal density high, and
 * means the LLM is reasoning over the same evidence an analyst would see on
 * the Finding detail page, not re-deriving it from scratch.
 */
@Injectable()
export class IntentContextBuilder {
  constructor(
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Detection.name)
    private readonly detectionModel: Model<DetectionDocument>,
  ) {}

  async build(
    workspaceId: string,
    repositoryId: string,
    findingId?: string,
  ): Promise<IntentContext | null> {
    const ws = new Types.ObjectId(workspaceId);
    const repoOid = new Types.ObjectId(repositoryId);

    const repo = await this.repoModel
      .findOne({ _id: repoOid, workspaceId: ws })
      .lean()
      .exec();
    if (!repo) return null;

    const finding = findingId
      ? await this.findingModel
          .findOne({ _id: new Types.ObjectId(findingId), workspaceId: ws })
          .lean()
          .exec()
      : await this.findingModel
          .findOne({ repositoryId: repoOid, workspaceId: ws })
          .sort({ riskScore: -1 })
          .lean()
          .exec();
    if (!finding) return null;

    const detections = await this.detectionModel
      .find({ workspaceId: ws, findingId: finding._id })
      .select('ruleId category severity confidence evidence explanation')
      .lean()
      .exec();

    const otherReposByOwnerInWorkspace = await this.repoModel
      .countDocuments({
        workspaceId: ws,
        owner: repo.owner,
        _id: { $ne: repo._id },
      })
      .exec();

    return {
      repository: {
        fullName: repo.fullName,
        owner: repo.owner,
        description: repo.description || '',
        topics: repo.topics || [],
        language: repo.language || '',
        stars: repo.stars || 0,
        forks: repo.forks || 0,
        isFork: repo.isFork || false,
        githubCreatedAt: repo.githubCreatedAt?.toISOString(),
        githubPushedAt: repo.githubPushedAt?.toISOString(),
        otherReposByOwnerInWorkspace,
      },
      brand: finding.brandName
        ? {
            name: finding.brandName,
            matchType: finding.brandMatchEvidence?.type,
            matchLocation: finding.brandMatchEvidence?.location,
            matchedAlias: finding.brandMatchEvidence?.matchedAlias,
            matchedText: finding.brandMatchEvidence?.matchedText,
          }
        : undefined,
      deployment: repo.deployment
        ? {
            url: repo.deployment.url,
            state: repo.deployment.state,
            confirmedLive: detections.some(
              (d) => d.ruleId === 'confirmed-live-deployment',
            ),
          }
        : undefined,
      finding: {
        severity: finding.severity,
        riskScore: finding.riskScore,
        categories: finding.categories || [],
        origin: finding.origin,
      },
      detections: detections.map((d) => ({
        ruleId: d.ruleId,
        category: d.category,
        severity: d.severity,
        confidence: d.confidence,
        evidence: d.evidence,
        explanation: d.explanation,
      })),
    };
  }
}
