import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Finding, FindingDocument } from './schemas/finding.schema';
import {
  Detection,
  DetectionDocument,
} from '../detections/schemas/detection.schema';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import {
  OperatorFingerprint,
  OperatorFingerprintDocument,
} from '../detection/schemas/operator-fingerprint.schema';
import {
  RepositoryContributor,
  RepositoryContributorDocument,
} from '../repositories/schemas/repository-contributor.schema';
import {
  FindingStatus,
  FindingListStatus,
  Severity,
  ThreatCategory,
} from '../common/enums';
import {
  ThreatClass,
  categoriesForThreatClass,
  classifyThreat,
} from '../common/threat-classification';
import { UpdateFindingStatusDto } from './dto/update-finding-status.dto';
import { UpdateFindingListStatusDto } from './dto/update-finding-list-status.dto';
import { GitHubService } from '../github/github.service';
import { getSecretPatternById } from '../detection/rules/secrets.rule';
import {
  CredentialVerificationService,
  VerificationResult,
} from '../detection/credential-verification.service';

export interface FindingFilters {
  workspaceId: string;
  search?: string;
  severity?: Severity;
  category?: ThreatCategory;
  /** credential_exposure (operational leak risk) vs malicious_intent (adversarial). */
  threatClass?: ThreatClass;
  /** internal = found in the brand's own repo; external = found in someone else's. */
  origin?: 'internal' | 'external';
  brand?: string;
  status?: FindingStatus;
  /** Analyst classification tag (watchlist/ignorelist/allowlist/blocklist) - independent of `status`. */
  listStatus?: FindingListStatus;
  from?: Date;
  to?: Date;
  /**
   * Filters by the underlying repo's GitHub activity (created OR pushed
   * within this range), not by when we recorded the finding - `from`/`to`
   * above answer "what did we discover recently," this answers "what's
   * actually been active on GitHub recently," which is what most triage
   * actually cares about (a repo scanned last week whose owner pushed a new
   * secret this morning should surface, even though the finding itself
   * isn't new).
   */
  repoActiveFrom?: Date;
  repoActiveTo?: Date;
  /** true = only repos with a live deployment URL; false = only repos with none ("not defined"); undefined = no filter. */
  hasDeployment?: boolean;
  /** AI verdict (see RepositoryIntent) denormalized onto Finding.latestIntent - undefined = no filter. */
  intentVerdict?: string;
  /** true = only findings the AI flagged for deep review; undefined = no filter. */
  needsDeepReview?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

@Injectable()
export class FindingsService {
  constructor(
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Detection.name)
    private readonly detectionModel: Model<DetectionDocument>,
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(OperatorFingerprint.name)
    private readonly fingerprintModel: Model<OperatorFingerprintDocument>,
    @InjectModel(RepositoryContributor.name)
    private readonly contributorModel: Model<RepositoryContributorDocument>,
    private readonly github: GitHubService,
    private readonly credentialVerification: CredentialVerificationService,
  ) {}

  async list(filters: FindingFilters): Promise<{
    data: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;
    const workspaceId = new Types.ObjectId(filters.workspaceId);

    const query: FilterQuery<FindingDocument> = { workspaceId };
    if (filters.severity) query.severity = filters.severity;
    if (filters.origin) query.origin = filters.origin;
    // Built as a plain, narrowly-typed local first - assigning the branches
    // directly onto `query.categories` blows up TS's inference (it tries to
    // serialize the resulting type against Mongoose's already-complex
    // FilterQuery generic and gives up: "exceeds the maximum length").
    let categoriesFilter:
      ThreatCategory | { $in: ThreatCategory[] } | undefined;
    if (filters.category && filters.threatClass) {
      // Both given: only meaningful if the specific category actually
      // belongs to the requested class - otherwise intersect to nothing
      // rather than silently ignoring one of the two filters.
      const inClass = categoriesForThreatClass(filters.threatClass).includes(
        filters.category,
      );
      categoriesFilter = inClass ? filters.category : { $in: [] };
    } else if (filters.category) {
      categoriesFilter = filters.category;
    } else if (filters.threatClass) {
      categoriesFilter = { $in: categoriesForThreatClass(filters.threatClass) };
    }
    if (categoriesFilter !== undefined) query.categories = categoriesFilter;
    if (filters.status) query.status = filters.status;
    if (filters.listStatus) query.listStatus = filters.listStatus;
    if (filters.intentVerdict) query.latestIntent = filters.intentVerdict;
    if (filters.needsDeepReview !== undefined)
      query.needsDeepReview = filters.needsDeepReview;
    if (filters.brand) query.brandName = new RegExp(filters.brand, 'i');
    if (filters.from || filters.to) {
      query.createdAt = {};
      if (filters.from)
        (query.createdAt as Record<string, Date>).$gte = filters.from;
      if (filters.to)
        (query.createdAt as Record<string, Date>).$lte = filters.to;
    }
    if (filters.search) {
      query.$or = [
        { summary: new RegExp(filters.search, 'i') },
        { brandName: new RegExp(filters.search, 'i') },
      ];
    }
    {
      // Repository, not Finding, is the source of truth for both GitHub
      // activity timestamps and current analysis state - populate() runs
      // after find(), so it can't filter on either directly. Resolve
      // matching repo ids first, then intersect - cheap relative to the
      // findings query itself since this collection is indexed on both
      // (workspaceId, githubPushedAt) and (workspaceId, pendingAnalysis).
      //
      // pendingAnalysis:false is applied unconditionally, not just when an
      // activity filter is given: a repo can be re-discovered later by a
      // fresh keyword scan's discovery-only pass, which flips
      // pendingAnalysis back to true even though it was already
      // content-analyzed and already has Finding documents from that
      // earlier pass. Those documents remain completely valid evidence, but
      // the repo's *current* state says "awaiting (re-)analysis" - the
      // Findings page should only ever show findings for repos analysis has
      // actually run against as of right now, so exclude anything currently
      // pending.
      const repoFilter: FilterQuery<RepositoryDocument> = {
        workspaceId,
        pendingAnalysis: false,
      };
      if (filters.repoActiveFrom || filters.repoActiveTo) {
        const activityRange: Record<string, Date> = {};
        if (filters.repoActiveFrom) activityRange.$gte = filters.repoActiveFrom;
        if (filters.repoActiveTo) activityRange.$lte = filters.repoActiveTo;
        repoFilter.$or = [
          { githubCreatedAt: activityRange },
          { githubPushedAt: activityRange },
        ];
      }
      // Deployment defaults to null on every repo (see Repository.deployment)
      // whether or not it's been analyzed yet, so this single equality check
      // correctly covers both "analyzed, no live deployment found" and "not
      // analyzed yet" as one "not defined" bucket.
      if (filters.hasDeployment !== undefined) {
        repoFilter.deployment = filters.hasDeployment ? { $ne: null } : null;
      }
      const eligibleRepoIds = await this.repoModel
        .find(repoFilter)
        .distinct('_id')
        .exec();
      query.repositoryId = { $in: eligibleRepoIds };
    }

    const allowedSort = new Set([
      'createdAt',
      'riskScore',
      'severity',
      'lastSeenAt',
      'status',
      'keywordMatchCount',
    ]);
    const sortBy = allowedSort.has(filters.sortBy || '')
      ? filters.sortBy!
      : 'createdAt';
    const sortOrder = filters.sortOrder === 'asc' ? 1 : -1;

    const [rows, total] = await Promise.all([
      this.findingModel
        .find(query)
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(limit)
        .populate('repositoryId')
        .lean()
        .exec(),
      this.findingModel.countDocuments(query).exec(),
    ]);

    const data: Record<string, unknown>[] = rows.map((f) => ({
      ...f,
      threatClass: classifyThreat(f.categories),
    }));

    return { data, total, page, limit };
  }

  async getById(
    workspaceId: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Finding not found');
    }

    const finding = await this.findingModel
      .findOne({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .populate('repositoryId')
      .lean()
      .exec();
    if (!finding) throw new NotFoundException('Finding not found');

    const detections = await this.detectionModel
      .find({
        // Must be explicitly cast: unlike the `_id` filter above, Mongoose
        // does not reliably auto-cast a plain string for a regular
        // ObjectId-typed field, so an uncast string here silently matches
        // nothing even when matching detections exist.
        findingId: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .lean()
      .exec();

    const repo = finding.repositoryId as
      { _id: Types.ObjectId } | Types.ObjectId | undefined;
    const repositoryId =
      repo && typeof repo === 'object' && '_id' in repo ? repo._id : repo;
    const linkedIdentities = repositoryId
      ? await this.getLinkedIdentities(workspaceId, String(repositoryId))
      : [];
    const contributors = repositoryId
      ? await this.getContributors(workspaceId, String(repositoryId))
      : [];

    return {
      ...finding,
      threatClass: classifyThreat(finding.categories),
      detections,
      linkedIdentities,
      contributors,
    };
  }

  /**
   * This repo's own contributor roster (from GitHub's contributors API),
   * each annotated with every OTHER repo in this workspace the same login
   * has also contributed to - the contributor analogue of getLinkedIdentities
   * above, computed fresh on every read for the same reason.
   */
  async getContributors(
    workspaceId: string,
    repositoryId: string,
  ): Promise<
    Array<{
      login: string;
      avatarUrl?: string;
      contributions: number;
      otherRepositories: Array<{ repositoryId: string; fullName: string }>;
    }>
  > {
    const ws = new Types.ObjectId(workspaceId);
    const repoOid = new Types.ObjectId(repositoryId);

    const own = await this.contributorModel
      .find({ workspaceId: ws, repositoryId: repoOid })
      .lean()
      .exec();
    if (own.length === 0) return [];

    const others = await this.contributorModel
      .find({
        workspaceId: ws,
        repositoryId: { $ne: repoOid },
        login: { $in: own.map((c) => c.login) },
      })
      .lean()
      .exec();

    const otherByLogin = new Map<
      string,
      Array<{ repositoryId: string; fullName: string }>
    >();
    for (const o of others) {
      const list = otherByLogin.get(o.login) || [];
      list.push({ repositoryId: String(o.repositoryId), fullName: o.fullName });
      otherByLogin.set(o.login, list);
    }

    return own.map((c) => ({
      login: c.login,
      avatarUrl: c.avatarUrl,
      contributions: c.contributions,
      otherRepositories: otherByLogin.get(c.login) || [],
    }));
  }

  /**
   * Every *other* repo in this workspace that shares one of this repo's own
   * contact/wallet fingerprints (email, Telegram, wallet address, etc.) -
   * computed fresh on every read, same as threatClass above, so it reflects
   * whatever the most recent scan of *any* repo has found rather than only
   * what was true when this particular repo was last scanned.
   */
  async getLinkedIdentities(
    workspaceId: string,
    repositoryId: string,
  ): Promise<
    Array<{
      kind: string;
      value: string;
      owner: string;
      fullName: string;
      repositoryId: string;
    }>
  > {
    const ws = new Types.ObjectId(workspaceId);
    const repoOid = new Types.ObjectId(repositoryId);

    const own = await this.fingerprintModel
      .find({ workspaceId: ws, repositoryId: repoOid })
      .lean()
      .exec();
    if (own.length === 0) return [];

    const matches = await this.fingerprintModel
      .find({
        workspaceId: ws,
        repositoryId: { $ne: repoOid },
        $or: own.map((f) => ({ kind: f.kind, value: f.value })),
      })
      .lean()
      .exec();

    return matches.map((m) => ({
      kind: m.kind,
      value: m.value,
      owner: m.owner,
      fullName: m.fullName,
      repositoryId: String(m.repositoryId),
    }));
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    userId: string,
    dto: UpdateFindingStatusDto,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Finding not found');
    }
    if (!Object.values(FindingStatus).includes(dto.status)) {
      throw new BadRequestException('Invalid finding status');
    }

    const finding = await this.findingModel
      .findOne({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!finding) throw new NotFoundException('Finding not found');

    finding.status = dto.status;
    finding.triageNote = (dto.note || '').trim();
    finding.triagedBy = new Types.ObjectId(userId);
    finding.triagedAt = new Date();

    if (
      dto.status === FindingStatus.RESOLVED ||
      dto.status === FindingStatus.FALSE_POSITIVE
    ) {
      finding.resolvedAt = new Date();
    } else if (
      dto.status === FindingStatus.OPEN ||
      dto.status === FindingStatus.ACKNOWLEDGED
    ) {
      finding.resolvedAt = undefined;
    }

    await finding.save();
    return this.getById(workspaceId, id);
  }

  /**
   * Sets the analyst classification tag (watchlist/ignorelist/allowlist/
   * blocklist) - a separate axis from `status` above (triage workflow
   * state). See FindingListStatus for what each value means.
   */
  async updateListStatus(
    workspaceId: string,
    id: string,
    dto: UpdateFindingListStatusDto,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Finding not found');
    }
    if (!Object.values(FindingListStatus).includes(dto.listStatus)) {
      throw new BadRequestException('Invalid list status');
    }

    const finding = await this.findingModel
      .findOne({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!finding) throw new NotFoundException('Finding not found');

    finding.listStatus = dto.listStatus;
    await finding.save();
    return this.getById(workspaceId, id);
  }

  /**
   * Analyst-triggered, on-demand check of whether an exposed-secret
   * detection is still a live, working credential. Re-fetches the file
   * fresh from GitHub and re-applies the same pattern the detection was
   * originally found with - the raw secret value is never stored at rest
   * (only the redacted form lives in `evidence`/`matchedText`), so this is
   * the only way to get the actual value back for a real check, and it's
   * discarded again immediately after use. Only ever a manual, per-finding
   * action - never run automatically during a scan - since firing a live
   * request against every found secret risks tripping a canary token or
   * alerting whoever leaked/planted it.
   */
  async verifyDetectionCredential(
    workspaceId: string,
    findingId: string,
    detectionId: string,
  ): Promise<VerificationResult> {
    if (
      !Types.ObjectId.isValid(findingId) ||
      !Types.ObjectId.isValid(detectionId)
    ) {
      throw new NotFoundException('Finding or detection not found');
    }
    const ws = new Types.ObjectId(workspaceId);

    const finding = await this.findingModel
      .findOne({ _id: findingId, workspaceId: ws })
      .lean()
      .exec();
    if (!finding) throw new NotFoundException('Finding not found');

    const detection = await this.detectionModel
      .findOne({
        _id: detectionId,
        findingId: new Types.ObjectId(findingId),
        workspaceId: ws,
      })
      .exec();
    if (!detection) throw new NotFoundException('Detection not found');

    const persist = async (result: VerificationResult) => {
      detection.verification = result;
      await detection.save();
      return result;
    };

    if (detection.category !== ThreatCategory.EXPOSED_SECRET) {
      return persist({
        status: 'unsupported',
        detail: 'Only exposed-secret findings can be verified this way.',
        checkedAt: new Date(),
      });
    }

    const pattern = getSecretPatternById(detection.ruleId);
    if (!pattern) {
      return persist({
        status: 'unsupported',
        detail: 'No known pattern registered for this rule.',
        checkedAt: new Date(),
      });
    }

    if (!detection.file || detection.file.startsWith('history/')) {
      return persist({
        status: 'unsupported',
        detail:
          'This match came from historical commit content, which cannot be safely re-fetched for verification in this version.',
        checkedAt: new Date(),
      });
    }

    const repo = await this.repoModel
      .findById(finding.repositoryId)
      .lean()
      .exec();
    if (!repo) {
      return persist({
        status: 'error',
        detail: 'Repository record not found - cannot re-fetch file content.',
        checkedAt: new Date(),
      });
    }

    let content: string | null;
    try {
      content = await this.github.getSmallTextFile(
        repo.owner,
        repo.name,
        detection.file,
        { workspaceId },
      );
    } catch (error) {
      return persist({
        status: 'error',
        detail: `Could not re-fetch the file from GitHub: ${error instanceof Error ? error.message : 'unknown error'}.`,
        checkedAt: new Date(),
      });
    }

    if (!content) {
      return persist({
        status: 'invalid',
        detail:
          'The file no longer exists or is empty - this secret has likely already been removed.',
        checkedAt: new Date(),
      });
    }

    const match = content.match(pattern.regex);
    if (!match?.length) {
      return persist({
        status: 'invalid',
        detail:
          'This pattern is no longer present in the current file content - likely already rotated or removed.',
        checkedAt: new Date(),
      });
    }

    const result = await this.credentialVerification.verify(
      detection.ruleId,
      match[0],
    );
    return persist(result);
  }

  /**
   * Per-rule precision within this workspace: how often a rule's findings
   * get triaged as false_positive vs kept as real. A rule that's wrong most
   * of the time in THIS workspace's data is a concrete, workspace-specific
   * signal worth surfacing directly to the analyst - "this rule has been
   * marked false-positive 40% of the time here" - rather than leaving that
   * pattern implicit in a long triage history nobody aggregates by hand.
   * Read-only and derived from existing Finding/Detection data on every
   * call - no separate counter to keep in sync, no historical backfill.
   */
  async getRulePrecisionStats(workspaceId: string): Promise<
    Array<{
      ruleId: string;
      ruleName: string;
      totalFindings: number;
      falsePositiveCount: number;
      falsePositiveRate: number;
    }>
  > {
    const rows = await this.detectionModel.aggregate<{
      _id: string;
      ruleName: string;
      totalFindings: number;
      falsePositiveCount: number;
    }>([
      { $match: { workspaceId: new Types.ObjectId(workspaceId) } },
      {
        $lookup: {
          from: 'findings',
          localField: 'findingId',
          foreignField: '_id',
          as: 'finding',
        },
      },
      { $unwind: '$finding' },
      {
        $group: {
          _id: { ruleId: '$ruleId', findingId: '$findingId' },
          ruleName: { $first: '$ruleName' },
          status: { $first: '$finding.status' },
        },
      },
      {
        $group: {
          _id: '$_id.ruleId',
          ruleName: { $first: '$ruleName' },
          totalFindings: { $sum: 1 },
          falsePositiveCount: {
            $sum: {
              $cond: [{ $eq: ['$status', FindingStatus.FALSE_POSITIVE] }, 1, 0],
            },
          },
        },
      },
      { $sort: { totalFindings: -1 } },
    ]);

    return rows.map((r) => ({
      ruleId: r._id,
      ruleName: r.ruleName,
      totalFindings: r.totalFindings,
      falsePositiveCount: r.falsePositiveCount,
      falsePositiveRate:
        r.totalFindings > 0
          ? Math.round((r.falsePositiveCount / r.totalFindings) * 100) / 100
          : 0,
    }));
  }
}
