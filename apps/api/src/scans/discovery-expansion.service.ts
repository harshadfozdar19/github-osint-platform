import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ScanMode } from '../common/enums';
import { GitHubRepoSearchItem, GitHubService } from '../github/github.service';
import { IncrementalScanService } from './incremental-scan.service';
import { ScanStateService } from './scan-state.service';
import { ScanQueueService } from '../queues/scan-queue.service';
import { ScanJob, ScanJobDocument } from './schemas/scan-job.schema';
import { ScanPipelineService } from './scan-pipeline.service';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../brands/schemas/monitored-brand.schema';
import { Keyword, KeywordDocument } from '../keywords/schemas/keyword.schema';
import { DEFAULT_SEEDED_KEYWORDS } from '../keywords/keywords.service';
import { Types } from 'mongoose';

/**
 * Expands scan coverage from confirmed Critical/High hits:
 * - owner fan-out (other repos by the same actor)
 * - fork walking (clones of the confirmed bad repo)
 */
@Injectable()
export class DiscoveryExpansionService {
  private readonly logger = new Logger(DiscoveryExpansionService.name);

  constructor(
    private readonly github: GitHubService,
    private readonly incremental: IncrementalScanService,
    private readonly scanState: ScanStateService,
    private readonly scanQueue: ScanQueueService,
    private readonly pipeline: ScanPipelineService,
    private readonly config: ConfigService,
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    @InjectModel(Keyword.name)
    private readonly keywordModel: Model<KeywordDocument>,
  ) {}

  /**
   * Feedback loop: when a Critical/High finding confirms a repo is a real
   * threat, check its name/description/topics against the curated keyword
   * universe and auto-enable any matching term the workspace hasn't already
   * turned on. Future scans' query generation (query-families.ts) reads from
   * the keywords table, so this grows discovery coverage from what the
   * system actually finds instead of only from queries picked in advance —
   * no AI needed, just closing the loop that already exists.
   */
  async promoteKeywordsFromFinding(
    workspaceId: string,
    text: string,
  ): Promise<number> {
    if (
      String(
        this.config.get('AUTO_PROMOTE_KEYWORDS') ?? 'true',
      ).toLowerCase() === 'false'
    ) {
      return 0;
    }
    const blob = text.toLowerCase();
    const ws = new Types.ObjectId(workspaceId);

    const existing = await this.keywordModel
      .find({ workspaceId: ws })
      .select('keyword')
      .lean()
      .exec();
    const existingSet = new Set(existing.map((k) => k.keyword));

    const candidates = DEFAULT_SEEDED_KEYWORDS.filter(
      (k) => blob.includes(k.keyword) && !existingSet.has(k.keyword),
    ).slice(0, 2);

    let promoted = 0;
    for (const candidate of candidates) {
      const result = await this.keywordModel.updateOne(
        { workspaceId: ws, keyword: candidate.keyword },
        {
          $setOnInsert: {
            workspaceId: ws,
            keyword: candidate.keyword,
            category: candidate.category,
            priority: candidate.priority,
            enabled: true,
            source: 'auto',
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) {
        promoted += 1;
        this.logger.log(
          `Auto-promoted keyword "${candidate.keyword}" (${candidate.category}) for workspace ${workspaceId}`,
        );
      }
    }
    return promoted;
  }

  async expandFromFinding(input: {
    workspaceId: string;
    scanJobId: string;
    owner: string;
    fullName: string;
    githubId: number;
    mode?: ScanMode;
    forceFullScan?: boolean;
    rulesetVersion?: string;
  }): Promise<number> {
    const ownerLimit = Number(this.config.get('SCAN_OWNER_FANOUT_LIMIT') || 5);
    const forkLimit = Number(this.config.get('SCAN_FORK_WALK_LIMIT') || 5);

    const scan = await this.scanModel.findById(input.scanJobId).lean().exec();
    if (!scan) return 0;
    if (await this.scanState.isTerminal(input.scanJobId)) return 0;
    // Prefer the value resolved (and clamped to the admin ceiling) at enqueue
    // time; fall back to config for pre-existing scans that predate this field.
    const maxRepos =
      scan.maxRepos ||
      Number(
        this.config.get('MAX_REPOSITORIES') ||
          this.config.get('SCAN_MAX_REPOS') ||
          Number.MAX_SAFE_INTEGER,
      );
    const remaining = Math.max(0, maxRepos - (scan.reposDiscovered || 0));
    if (remaining <= 0) return 0;

    const allEnabledBrands = await this.brandModel
      .find({
        workspaceId: new Types.ObjectId(input.workspaceId),
        enabled: true,
      })
      .lean()
      .exec();
    // Keep a brand-scoped scan scoped through owner/fork expansion too -
    // otherwise a repo pulled in because it's owned by a confirmed bad
    // actor could still get attributed to some unrelated monitored brand.
    const brands = scan.scopeBrandId
      ? allEnabledBrands.filter(
          (b) => String(b._id) === String(scan.scopeBrandId),
        )
      : allEnabledBrands;

    const mode = input.mode || ScanMode.INCREMENTAL;
    const forceFullScan = input.forceFullScan === true;
    const rulesetVersion =
      input.rulesetVersion || this.incremental.currentRulesetVersion();

    const candidates: GitHubRepoSearchItem[] = [];

    if (
      await this.incremental.claimOwnerExpansion(input.scanJobId, input.owner)
    ) {
      try {
        const owned = await this.github.listUserRepos(
          input.owner,
          ownerLimit + 2,
          { workspaceId: input.workspaceId, scanJobId: input.scanJobId },
        );
        candidates.push(...owned.slice(0, ownerLimit));
      } catch (error) {
        this.logger.warn(
          `Owner fan-out failed for ${input.owner}: ${(error as Error).message}`,
        );
      }
    }

    const [forkOwner, forkName] = input.fullName.split('/');
    if (
      forkOwner &&
      forkName &&
      (await this.incremental.claimForkExpansion(
        input.scanJobId,
        input.githubId,
      ))
    ) {
      try {
        const forks = await this.github.listForks(
          forkOwner,
          forkName,
          forkLimit,
          { workspaceId: input.workspaceId, scanJobId: input.scanJobId },
        );
        candidates.push(...forks.slice(0, forkLimit));
      } catch (error) {
        this.logger.warn(
          `Fork walk failed for ${input.fullName}: ${(error as Error).message}`,
        );
      }
    }

    let enqueued = 0;
    for (const item of candidates) {
      if (await this.scanState.isCancelled(input.scanJobId)) break;

      const claimed = await this.incremental.claimRepositoryForAnalysis(
        input.scanJobId,
        item.id,
        maxRepos,
      );
      if (!claimed) continue;

      // Same ordering requirement as the search discovery path (see
      // github-search.processor.ts) - record the discovery credit before
      // enqueueing, not after this whole loop finishes.
      await this.scanState.recordRepositoryDiscovered(input.scanJobId);

      await this.scanQueue.enqueueRepositoryAnalysis(
        {
          workspaceId: input.workspaceId,
          scanJobId: input.scanJobId,
          mode,
          forceFullScan,
          rulesetVersion,
          repo: {
            id: item.id,
            full_name: item.full_name,
            html_url: item.html_url,
            description: item.description,
            stargazers_count: item.stargazers_count,
            forks_count: item.forks_count,
            fork: item.fork,
            language: item.language,
            topics: item.topics,
            created_at: item.created_at,
            updated_at: item.updated_at,
            pushed_at: item.pushed_at,
            owner: { login: item.owner.login },
            name: item.name,
            default_branch: item.default_branch,
          },
          brands: brands.map((b) => ({
            id: String(b._id),
            name: b.name,
            aliases: b.aliases,
            trustedGithubOwners: b.trustedGithubOwners,
            keywords: b.keywords,
          })),
        },
        6,
      );
      enqueued += 1;
    }

    if (enqueued > 0) {
      await this.scanState.recordExpansionEnqueued(input.scanJobId, enqueued);
      this.logger.log(
        `Expanded ${enqueued} repos from ${input.fullName} (owner/forks)`,
      );
    }
    return enqueued;
  }
}
