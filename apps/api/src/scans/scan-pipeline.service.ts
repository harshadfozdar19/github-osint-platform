import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { FindingChangeType, FindingStatus, Severity } from '../common/enums';
import { DetectionEngine } from '../detection/detection.engine';
import { RiskScoringService } from '../detection/risk-scoring.service';
import { RepoAnalysisContext } from '../detection/rules/rule.types';
import { jaroWinkler } from '../common/utils/string-similarity';
import { GitHubService } from '../github/github.service';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import {
  Detection,
  DetectionDocument,
} from '../detections/schemas/detection.schema';
import type { RepositoryAnalysisJobData } from '../queues/queue.constants';
import {
  buildQueryFamilies,
  SearchQuerySpec,
} from './discovery/query-families';

const TEXT_FILE_RE =
  /(^|\/)(dockerfile|docker-compose.*|package.*|requirements\.txt|pom\.xml|build\.gradle|gradle\.properties|.*\.env.*|.*\.pem$|.*\.key$|.*\.jks$)|(\.(env|md|txt|json|yml|yaml|js|ts|jsx|tsx|py|sh|html|htm|xml|ini|cfg|conf|properties|toml|gradle|properties|key|pem|jks))$/i;

function pathPriority(path: string): number {
  const p = path.toLowerCase();
  const filename = p.split('/').pop() || '';
  if (filename === '.env' || filename.startsWith('.env.')) return 100;
  if (
    filename === 'credentials.json' ||
    filename === 'secrets.json' ||
    filename === 'serviceaccount.json' ||
    filename === 'service-account.json'
  )
    return 93;
  if (
    filename === 'firebase.json' ||
    filename === 'google-services.json' ||
    filename === '.firebaserc'
  )
    return 92;
  if (/\.(pem|key|jks|p12|pfx)$/.test(p) || /id_rsa|id_ed25519/.test(p))
    return 95;
  if (/credential|secret|password/.test(p)) return 90;
  if (filename === '.npmrc' || filename === '.pypirc' || filename === 'netrc')
    return 88;
  if (
    filename === 'docker-compose.yml' ||
    filename === 'docker-compose.yaml' ||
    filename === 'package.json' ||
    filename === 'package-lock.json' ||
    filename === 'requirements.txt' ||
    filename === 'pom.xml' ||
    filename === 'build.gradle' ||
    filename === 'gradle.properties'
  )
    return 85;
  if (filename === 'terraform.tfvars' || filename.endsWith('.tfvars'))
    return 84;
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.'))
    return 80;
  if (filename === 'appsettings.json' || filename === 'config.json') return 78;
  if (p.includes('.github/workflows/')) return 75;
  if (filename.startsWith('readme')) return 70;
  if (/\.(properties|json|yml|yaml)$/.test(p)) return 60;
  if (TEXT_FILE_RE.test(p)) return 40;
  return 0;
}

@Injectable()
export class ScanPipelineService {
  private readonly logger = new Logger(ScanPipelineService.name);

  constructor(
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Detection.name)
    private readonly detectionModel: Model<DetectionDocument>,
    private readonly github: GitHubService,
    private readonly detectionEngine: DetectionEngine,
    private readonly riskScoring: RiskScoringService,
    private readonly config: ConfigService,
  ) {}

  buildSearchQueries(
    brands: Array<{ name: string; aliases: string[]; keywords: string[] }>,
    keywords?: Array<{ keyword: string; category: string; priority: number }>,
  ): SearchQuerySpec[] {
    const maxQueries = Number(this.config.get('SCAN_MAX_QUERIES') || 40);
    const enableCodeSearch =
      String(this.config.get('ENABLE_CODE_SEARCH') ?? 'true').toLowerCase() !==
      'false';
    return buildQueryFamilies(brands, {
      maxQueries,
      enableCodeSearch,
      includeSecretFilenames: true,
      keywords,
    });
  }

  matchBrand(
    brands: Array<{ _id: Types.ObjectId; name: string; aliases: string[] }>,
    item: { full_name: string; description: string | null; topics?: string[] },
  ) {
    const blob =
      `${item.full_name} ${item.description || ''} ${(item.topics || []).join(' ')}`.toLowerCase();
    for (const brand of brands) {
      const aliases = [brand.name, ...brand.aliases].map((a) =>
        a.toLowerCase(),
      );
      // Exact match first (fast path)
      if (aliases.some((a) => blob.includes(a))) {
        return brand;
      }
      // Fuzzy match using Jaro‑Winkler – consider match if similarity >= 0.85
      const similarityThreshold = 0.85;
      if (aliases.some((a) => jaroWinkler(blob, a) >= similarityThreshold)) {
        return brand;
      }
    }
    return undefined;
  }

  async fetchRepositoryContext(
    item: RepositoryAnalysisJobData['repo'],
    matchedBrand?: RepositoryAnalysisJobData['matchedBrand'],
    requestCtx: {
      workspaceId?: string;
      scanJobId?: string;
      signal?: AbortSignal;
    } = {},
    options: { commitSha?: string; maxFiles?: number } = {},
  ): Promise<{
    repositoryDbId: string;
    ctx: RepoAnalysisContext;
    contentEtag?: string;
  }> {
    const [owner, name] = item.full_name.split('/');
    let filePaths: string[] = [];
    let readmeText = '';
    const smallFileTexts: Array<{ path: string; content: string }> = [];
    const maxFiles =
      options.maxFiles ??
      Number(
        this.config.get('SCAN_MAX_FILES_PER_REPO') ||
          this.config.get('MAX_FILES_PER_REPO') ||
          12,
      );

    try {
      if (options.commitSha) {
        filePaths = await this.github.listTreePaths(
          owner,
          name,
          options.commitSha,
          requestCtx,
        );
      }
      if (filePaths.length === 0) {
        filePaths = await this.github.listRootPaths(owner, name, requestCtx);
      }
      readmeText = await this.github.getReadme(owner, name, requestCtx);

      const ranked = [...filePaths]
        .map((p) => ({ path: p, score: pathPriority(p) }))
        .filter((p) => p.score > 0 && TEXT_FILE_RE.test(p.path))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

      // Prefer high-value secret paths; fill remaining slots with other text files
      const selected: string[] = [];
      for (const entry of ranked) {
        if (selected.length >= maxFiles) break;
        selected.push(entry.path);
      }
      if (selected.length < maxFiles) {
        for (const p of filePaths) {
          if (selected.length >= maxFiles) break;
          if (selected.includes(p)) continue;
          if (!TEXT_FILE_RE.test(p)) continue;
          selected.push(p);
        }
      }

      for (const path of selected) {
        const content = await this.github.getSmallTextFile(
          owner,
          name,
          path,
          requestCtx,
        );
        if (content) smallFileTexts.push({ path, content });
      }
    } catch (error) {
      this.logger.warn(
        `Content fetch limited for ${item.full_name}: ${(error as Error).message}`,
      );
      throw error;
    }

    return {
      repositoryDbId: '',
      ctx: {
        fullName: item.full_name,
        owner: item.owner.login,
        name: item.name,
        description: item.description || '',
        topics: item.topics || [],
        language: item.language || '',
        stars: item.stargazers_count,
        forks: item.forks_count,
        isFork: item.fork,
        githubCreatedAt: new Date(item.created_at),
        githubPushedAt: new Date(item.pushed_at),
        filePaths,
        readmeText,
        smallFileTexts,
        matchedBrandName: matchedBrand?.name,
        matchedBrandAliases: matchedBrand?.aliases,
      },
    };
  }

  /**
   * Look for secrets committed and later removed by scanning recent commit
   * diffs, not just the current tree. Content analysis of HEAD alone misses
   * the extremely common "commit .env, notice, delete it" pattern — the
   * secret is still fully recoverable from history even once HEAD is clean.
   * Mutates and returns ctx.smallFileTexts with history-tagged entries so the
   * existing secrets rule engine picks them up without any rule changes;
   * findings from these get file paths like `history/<sha>/config.env` so
   * they're clearly distinguishable from live-HEAD evidence.
   */
  async appendHistoricalSecretSignals(
    owner: string,
    repo: string,
    headSha: string,
    ctx: RepoAnalysisContext,
    requestCtx: {
      workspaceId?: string;
      scanJobId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<RepoAnalysisContext> {
    const maxCommits = Number(this.config.get('GIT_HISTORY_MAX_COMMITS') || 15);
    const maxEntries = 30;

    try {
      const shas = await this.github.listRecentCommits(
        owner,
        repo,
        headSha,
        maxCommits,
        requestCtx,
      );
      for (const sha of shas) {
        if (ctx.smallFileTexts.length >= maxEntries) break;
        const files = await this.github.getCommitPatch(
          owner,
          repo,
          sha,
          requestCtx,
        );
        for (const file of files) {
          if (ctx.smallFileTexts.length >= maxEntries) break;
          if (!file.patch) continue;
          const added = file.patch
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
            .map((line) => line.slice(1))
            .join('\n');
          if (!added.trim()) continue;
          ctx.smallFileTexts.push({
            path: `history/${sha.slice(0, 7)}/${file.filename}`,
            content: added,
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `Git history scan limited for ${owner}/${repo}: ${(error as Error).message}`,
      );
    }

    return ctx;
  }

  async upsertRepository(
    workspaceId: string,
    item: RepositoryAnalysisJobData['repo'],
    extras: {
      defaultBranch?: string;
      commitSha?: string;
      contentEtag?: string;
      rulesetVersion?: string;
      scanJobId?: string;
      markSuccess?: boolean;
      markFailed?: boolean;
    } = {},
  ) {
    const ws = new Types.ObjectId(workspaceId);
    const update: Record<string, unknown> = {
      workspaceId: ws,
      githubId: item.id,
      fullName: item.full_name,
      url: item.html_url,
      owner: item.owner.login,
      name: item.name,
      description: item.description || '',
      language: item.language || '',
      topics: item.topics || [],
      stars: item.stargazers_count,
      forks: item.forks_count,
      isFork: item.fork,
      githubCreatedAt: new Date(item.created_at),
      githubUpdatedAt: item.updated_at
        ? new Date(item.updated_at)
        : new Date(item.pushed_at),
      githubPushedAt: new Date(item.pushed_at),
      lastScannedAt: new Date(),
      isDemo: false,
    };
    if (extras.defaultBranch) update.defaultBranch = extras.defaultBranch;
    if (extras.contentEtag !== undefined) {
      update.lastContentEtag = extras.contentEtag;
    }
    if (extras.scanJobId) {
      update.lastScanJobId = new Types.ObjectId(extras.scanJobId);
    }
    if (extras.markFailed) {
      update.lastProcessingFailed = true;
    }
    if (extras.markSuccess) {
      update.lastProcessingFailed = false;
      update.lastSuccessfulScanAt = new Date();
      if (extras.commitSha) update.lastProcessedCommitSha = extras.commitSha;
      if (extras.rulesetVersion) {
        update.lastRulesetVersion = extras.rulesetVersion;
      }
    }

    return this.repoModel.findOneAndUpdate(
      { workspaceId: ws, githubId: item.id },
      update,
      { upsert: true, new: true },
    );
  }

  async runDetectionAndPersist(input: {
    workspaceId: string;
    scanJobId: string;
    repositoryDbId: string;
    githubId: number;
    fullName: string;
    ctx: RepoAnalysisContext;
    brandId?: string;
    brandName?: string;
  }): Promise<{
    created: number;
    updated: number;
    findingsNew: number;
    findingsUnchanged: number;
    findingsReopened: number;
    findingsResolved: number;
    findingId?: string;
    shouldAlert: boolean;
    severity?: Severity;
  }> {
    const ws = new Types.ObjectId(input.workspaceId);
    const repoOid = new Types.ObjectId(input.repositoryDbId);
    const detections = this.detectionEngine.analyze(input.ctx);

    const meaningful = detections.filter(
      (d) => d.ruleId !== 'low-reputation-new-repo',
    );

    const empty = {
      created: 0,
      updated: 0,
      findingsNew: 0,
      findingsUnchanged: 0,
      findingsReopened: 0,
      findingsResolved: 0,
      shouldAlert: false,
    };

    if (meaningful.length === 0) {
      const resolved = await this.resolveMissingFindings(
        ws,
        repoOid,
        input.scanJobId,
        new Set(),
      );
      return { ...empty, findingsResolved: resolved };
    }

    const risk = this.riskScoring.calculate(detections, input.ctx);
    const fingerprint = this.fingerprint(
      input.githubId,
      detections.map((d) => d.ruleId),
    );
    const seenFingerprints = new Set([fingerprint]);

    const existing = await this.findingModel.findOne({
      workspaceId: ws,
      repositoryId: repoOid,
      fingerprint,
    });

    let finding: FindingDocument;
    let created = 0;
    let updated = 0;
    let findingsNew = 0;
    let findingsUnchanged = 0;
    let findingsReopened = 0;

    const summary = `${risk.severity.toUpperCase()} finding for ${input.fullName} (${detections.length} rule${detections.length === 1 ? '' : 's'} triggered)`;

    if (existing) {
      // false_positive is an analyst verdict that this exact pattern is not a
      // threat — unlike resolved (which means "was a real issue, got fixed"),
      // it must not auto-reopen on every rescan or triage noise never ends.
      // Metadata still refreshes so the record stays current; status/alerts don't.
      const wasFalsePositive = existing.status === FindingStatus.FALSE_POSITIVE;
      const wasResolved = existing.status === FindingStatus.RESOLVED;
      existing.severity = risk.severity;
      existing.riskScore = risk.score;
      existing.categories = [...new Set(detections.map((d) => d.category))];
      existing.riskBreakdown = risk.breakdown;
      existing.summary = summary;
      existing.lastSeenAt = new Date();
      existing.lastScanJobId = new Types.ObjectId(input.scanJobId);
      if (input.brandId) {
        existing.brandId = new Types.ObjectId(input.brandId);
        existing.brandName = input.brandName;
      }
      if (wasFalsePositive) {
        existing.lastChangeType = FindingChangeType.UNCHANGED;
        findingsUnchanged = 1;
      } else if (wasResolved) {
        existing.status = FindingStatus.OPEN;
        existing.lastChangeType = FindingChangeType.REOPENED;
        existing.reopenedAt = new Date();
        existing.resolvedAt = undefined;
        findingsReopened = 1;
      } else {
        existing.lastChangeType = FindingChangeType.UNCHANGED;
        findingsUnchanged = 1;
      }
      await existing.save();
      finding = existing;
      updated = 1;
      await this.detectionModel.deleteMany({
        findingId: finding._id,
        workspaceId: ws,
      });
    } else {
      finding = await this.findingModel.create({
        workspaceId: ws,
        repositoryId: repoOid,
        brandId: input.brandId ? new Types.ObjectId(input.brandId) : undefined,
        brandName: input.brandName,
        fingerprint,
        severity: risk.severity,
        riskScore: risk.score,
        categories: [...new Set(detections.map((d) => d.category))],
        riskBreakdown: risk.breakdown,
        summary,
        status: FindingStatus.OPEN,
        lastChangeType: FindingChangeType.NEW,
        lastScanJobId: new Types.ObjectId(input.scanJobId),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        isDemo: false,
      });
      created = 1;
      findingsNew = 1;
    }

    await this.detectionModel.insertMany(
      detections.map((d) => ({
        workspaceId: ws,
        findingId: finding._id,
        ruleId: d.ruleId,
        ruleName: d.ruleName,
        category: d.category,
        severity: d.severity,
        confidence: d.confidence,
        evidence: d.evidence,
        explanation: d.explanation,
        riskContribution: d.riskContribution,
        file: d.file,
        lineNumber: d.lineNumber,
        matchedText: d.matchedText,
      })),
    );

    const findingsResolved = await this.resolveMissingFindings(
      ws,
      repoOid,
      input.scanJobId,
      seenFingerprints,
    );

    const shouldAlert =
      (created === 1 || findingsReopened === 1) &&
      (risk.severity === Severity.CRITICAL || risk.severity === Severity.HIGH);

    return {
      created,
      updated,
      findingsNew,
      findingsUnchanged,
      findingsReopened,
      findingsResolved,
      findingId: String(finding._id),
      shouldAlert,
      severity: risk.severity,
    };
  }

  /** Mark open/acknowledged findings not seen in this analysis as resolved. */
  private async resolveMissingFindings(
    workspaceId: Types.ObjectId,
    repositoryId: Types.ObjectId,
    scanJobId: string,
    seenFingerprints: Set<string>,
  ): Promise<number> {
    const openFindings = await this.findingModel
      .find({
        workspaceId,
        repositoryId,
        status: {
          $in: [FindingStatus.OPEN, FindingStatus.ACKNOWLEDGED],
        },
      })
      .exec();
    let resolved = 0;
    for (const finding of openFindings) {
      if (seenFingerprints.has(finding.fingerprint)) continue;
      finding.status = FindingStatus.RESOLVED;
      finding.lastChangeType = FindingChangeType.RESOLVED;
      finding.resolvedAt = new Date();
      finding.lastScanJobId = new Types.ObjectId(scanJobId);
      await finding.save();
      resolved += 1;
    }
    return resolved;
  }

  private fingerprint(githubId: number, ruleIds: string[]): string {
    const payload = `${githubId}:${[...ruleIds].sort().join(',')}`;
    return createHash('sha256').update(payload).digest('hex').slice(0, 32);
  }
}
