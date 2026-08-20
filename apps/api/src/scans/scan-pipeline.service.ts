import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import {
  DetectionResult,
  FindingChangeType,
  FindingStatus,
  Severity,
  ThreatCategory,
} from '../common/enums';
import {
  DetectionEngine,
  IMPERSONATION_ONLY_RULE_IDS,
} from '../detection/detection.engine';
import {
  OperatorContext,
  RiskScoringService,
} from '../detection/risk-scoring.service';
import { RepoAnalysisContext } from '../detection/rules/rule.types';
import { findCredentialReuseMatches } from '../detection/rules/secrets.rule';
import { extractDataDestinations } from '../detection/rules/destination.util';
import { checkUrlLiveness } from '../detection/rules/liveness.util';
import {
  findFileHashReuseMatches,
  findPhraseReuseMatches,
} from '../fingerprints/content-reuse.util';
import {
  KnownClientSecret,
  KnownClientSecretDocument,
} from '../fingerprints/schemas/known-client-secret.schema';
import {
  DistinctiveContentString,
  DistinctiveContentStringDocument,
} from '../fingerprints/schemas/distinctive-content-string.schema';
import {
  CodeFingerprint,
  CodeFingerprintDocument,
} from '../fingerprints/schemas/code-fingerprint.schema';
import { jaroWinkler } from '../common/utils/string-similarity';
import {
  ExtractedFingerprint,
  extractOperatorFingerprints,
} from '../common/operator-fingerprint';
import { findBestBrandMatch, findBrandMatch } from '../common/brand-match';
import { CloneScanService } from './clone-scan.service';
import type { BrandTextMatch } from './clone-scan.service';
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
import {
  OperatorFingerprint,
  OperatorFingerprintDocument,
} from '../detection/schemas/operator-fingerprint.schema';
import {
  RepositoryContributor,
  RepositoryContributorDocument,
} from '../repositories/schemas/repository-contributor.schema';
import { RepositoryDeployment } from '../repositories/schemas/repository.schema';
import type { RepositoryAnalysisJobData } from '../queues/queue.constants';
import {
  buildQueryFamilies,
  SearchQuerySpec,
} from './discovery/query-families';

export const TEXT_FILE_RE =
  /(^|\/)(dockerfile|docker-compose.*|package.*|requirements\.txt|pom\.xml|build\.gradle|gradle\.properties|.*\.env.*|.*\.pem$|.*\.key$|.*\.jks$)|(\.(env|md|txt|json|yml|yaml|js|ts|jsx|tsx|py|sh|html|htm|xml|ini|cfg|conf|properties|toml|gradle|properties|key|pem|jks))$/i;

/**
 * `brandAliases` lets a file/folder deep in the tree whose name references
 * the monitored brand (`assets/logos/paypal-icon.svg`,
 * `src/scrapers/netflix_scraper.py`) jump the content-fetch queue - without
 * this, a repo with more text files than the per-scan budget could bury the
 * one file worth reading behind unrelated config/README files that happen
 * to rank higher on the fixed secret-file priorities below.
 */
export function pathPriority(
  path: string,
  brandAliases: string[] = [],
): number {
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
    brandAliases.length > 0 &&
    TEXT_FILE_RE.test(p) &&
    brandAliases.some((a) => a && p.includes(a.toLowerCase()))
  )
    return 82;
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
    @InjectModel(OperatorFingerprint.name)
    private readonly fingerprintModel: Model<OperatorFingerprintDocument>,
    private readonly github: GitHubService,
    private readonly detectionEngine: DetectionEngine,
    private readonly riskScoring: RiskScoringService,
    private readonly config: ConfigService,
    private readonly cloneScan: CloneScanService,
    // Optional (defaults to null) so the many existing direct-construction
    // call sites in tests don't all need updating - genuinely absent only
    // in tests; production DI (queues.module.ts) always provides it. When
    // null, the credential-reuse check below is skipped entirely, same as
    // if the brand simply had no known secrets yet.
    @InjectModel(KnownClientSecret.name)
    private readonly knownSecretModel: Model<KnownClientSecretDocument> | null = null,
    // Same optional pattern as knownSecretModel above - powers the
    // content-reuse (phrase) check.
    @InjectModel(DistinctiveContentString.name)
    private readonly contentStringModel: Model<DistinctiveContentStringDocument> | null = null,
    // Same optional pattern - powers the content-reuse (exact file copy) check.
    @InjectModel(CodeFingerprint.name)
    private readonly codeFingerprintModel: Model<CodeFingerprintDocument> | null = null,
    // Same optional pattern - powers deployment/contributor enrichment.
    @InjectModel(RepositoryContributor.name)
    private readonly contributorModel: Model<RepositoryContributorDocument> | null = null,
  ) {}

  buildSearchQueries(
    brands: Array<{
      name: string;
      aliases: string[];
      keywords: string[];
      trustedGithubOwners?: string[];
      distinctivePhrases?: string[];
    }>,
    keywords?: Array<{ keyword: string; category: string; priority: number }>,
    dateRange?: {
      createdFrom?: string;
      createdTo?: string;
      pushedFrom?: string;
      pushedTo?: string;
      /** 'or' = created OR pushed in range, instead of the 'and'/default intersection - see buildQueryFamilies. */
      dateFilterMode?: 'and' | 'or';
    },
    scopedToBrand?: boolean,
    /** Restricts every passed brand to only its brand-keyword-custom(-code) pair for this one keyword - see buildQueryFamilies' onlyKeyword option. */
    onlyKeyword?: string,
    /** Restricts onlyKeyword's query pair to just repo search or just code search instead of both - see buildQueryFamilies' searchScope option. Ignored without onlyKeyword. */
    searchScope?: 'both' | 'repositories' | 'code',
  ): SearchQuerySpec[] {
    // Raised from the old default of 40: a brand with a large curated
    // keyword list (name variants, products, execs, domains - 60+ terms is
    // realistic) needs real room for its own repo-search + code-search
    // queries on top of every other family, without silently starving them
    // or other brands in the same scan. GitHub's 30-requests/minute search
    // quota - not this number - is what actually paces how fast a scan with
    // this many queries completes; still overridable via SCAN_MAX_QUERIES.
    const maxQueries = Number(this.config.get('SCAN_MAX_QUERIES') || 200);
    const enableCodeSearch =
      String(this.config.get('ENABLE_CODE_SEARCH') ?? 'true').toLowerCase() !==
      'false';
    return buildQueryFamilies(brands, {
      maxQueries,
      enableCodeSearch,
      includeSecretFilenames: true,
      keywords,
      createdFrom: dateRange?.createdFrom,
      createdTo: dateRange?.createdTo,
      pushedFrom: dateRange?.pushedFrom,
      pushedTo: dateRange?.pushedTo,
      dateFilterMode: dateRange?.dateFilterMode,
      scopedToBrand,
      onlyKeyword,
      searchScope,
    });
  }

  matchBrand(
    brands: Array<{
      _id: Types.ObjectId;
      name: string;
      aliases: string[];
      trustedGithubOwners?: string[];
    }>,
    item: {
      full_name: string;
      description: string | null;
      topics?: string[];
      owner?: { login: string };
    },
  ) {
    // A repo owned by a brand's own known GitHub account is that brand's,
    // full stop - checked before any content matching since an internal
    // tool repo may never mention the brand name anywhere in its own
    // metadata at all (that's exactly the case this exists to catch).
    const ownerLogin = item.owner?.login?.toLowerCase();
    if (ownerLogin) {
      const ownerMatch = brands.find((brand) =>
        (brand.trustedGithubOwners || []).some(
          (o) => o.toLowerCase() === ownerLogin,
        ),
      );
      if (ownerMatch) return ownerMatch;
    }

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
    brands: RepositoryAnalysisJobData['brands'] = [],
    requestCtx: {
      workspaceId?: string;
      scanJobId?: string;
      signal?: AbortSignal;
    } = {},
    options: {
      commitSha?: string;
      maxFiles?: number;
      /**
       * Scan this one specific non-default branch instead of whatever the
       * remote's HEAD resolves to - see ScanMode.BRANCH_ANALYSIS. Only the
       * clone path supports fetching an arbitrary branch at all (every REST
       * fallback call below - listTreePaths/listRootPaths/getReadme/
       * getSmallTextFile - implicitly reads the DEFAULT branch, with no
       * branch parameter of its own), so when this is set the REST fallback
       * is disabled entirely rather than silently analyzing the wrong
       * branch: a failed/ineligible clone throws instead of falling through.
       */
      branch?: string;
    } = {},
  ): Promise<{
    repositoryDbId: string;
    ctx: RepoAnalysisContext;
    contentEtag?: string;
  }> {
    const [owner, name] = item.full_name.split('/');
    let filePaths: string[] = [];
    let readmeText = '';
    let readmePath: string | undefined;
    let smallFileTexts: Array<{ path: string; content: string }> = [];
    let brandFileMatches: BrandTextMatch[] | undefined;
    let keywordFileMatches: BrandTextMatch[] | undefined;
    let fullRepoSecretCandidates:
      Array<{ path: string; lineNumber: number; line: string }> | undefined;
    // Only binds for the repos that fall through to REST fetching below -
    // oversized (> CLONE_SCAN_MAX_REPO_SIZE_KB), clone-scan disabled, or no
    // git binary available. Most repos now go through the clone path's
    // full-tree git grep instead (see CloneScanService.shouldAttempt), so
    // this cap no longer bounds the common case - it's raised from the old
    // default of 12 mainly for repos too large to clone.
    const maxFiles =
      options.maxFiles ??
      Number(
        this.config.get('SCAN_MAX_FILES_PER_REPO') ||
          this.config.get('MAX_FILES_PER_REPO') ||
          40,
      );
    // Union of every enabled brand's aliases - not just one pre-matched
    // winner - so a repo whose brand mention only shows up deep in file
    // content still gets that content prioritized for fetch and grepped for.
    const brandAliases = [
      ...new Set(brands.flatMap((b) => [b.name, ...(b.aliases || [])])),
    ];
    // Same reasoning, for every enabled brand's own curated keywords - the
    // winning brand isn't known yet at clone time, so this greps for all of
    // them; customKeywordMatchRule filters back down to just the matched
    // brand's own list when it actually reads keywordFileMatches.
    const allKeywords = [...new Set(brands.flatMap((b) => b.keywords || []))];

    // Try a shallow git clone + local scan first when eligible - no GitHub
    // REST calls at all for content, so full-repo coverage instead of a
    // bounded priority-file list. Opt-in and fails closed: any problem here
    // (git missing, clone timeout, repo too large) just falls through to the
    // existing REST-based fetch below - UNLESS options.branch is set, in
    // which case there is no REST fallback to fall through to (see its doc
    // comment above), so a failed/ineligible clone throws instead.
    let usedClone = false;
    if (await this.cloneScan.shouldAttempt(item.size)) {
      const cloned = await this.cloneScan.cloneAndScan(
        owner,
        name,
        brandAliases,
        {
          customKeywords: allKeywords,
          branch: options.branch,
        },
      );
      if (cloned) {
        usedClone = true;
        filePaths = cloned.filePaths;
        readmeText = cloned.readmeText;
        readmePath = cloned.readmePath;
        smallFileTexts = cloned.smallFileTexts;
        brandFileMatches = cloned.brandMatches;
        keywordFileMatches = cloned.keywordMatches;
        fullRepoSecretCandidates = cloned.secretCandidates;
      }
    }

    if (!usedClone && options.branch) {
      throw new Error(
        `Could not clone ${item.full_name}@${options.branch} for branch analysis (git unavailable, repo too large, or clone failed) - no non-branch fallback exists for this mode`,
      );
    }

    if (!usedClone) {
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
        const readme = await this.github.getReadme(owner, name, requestCtx);
        readmeText = readme.text;
        readmePath = readme.path;

        const ranked = [...filePaths]
          .map((p) => ({ path: p, score: pathPriority(p, brandAliases) }))
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
    }

    const ctx: RepoAnalysisContext = {
      fullName: item.full_name,
      owner: item.owner.login,
      name: item.name,
      description: item.description || '',
      topics: item.topics || [],
      language: item.language || '',
      stars: item.stargazers_count,
      forks: item.forks_count,
      isFork: item.fork,
      // `new Date(undefined)` is an Invalid Date - a truthy object that
      // silently defeats every `if (ctx.githubCreatedAt)` age-based guard
      // downstream (risk-scoring, threat rules) instead of being skipped as
      // "unknown," so an absent value must stay `undefined`, never get
      // wrapped in Date() regardless.
      githubCreatedAt: item.created_at ? new Date(item.created_at) : undefined,
      githubPushedAt: item.pushed_at ? new Date(item.pushed_at) : undefined,
      filePaths,
      readmeText,
      readmePath,
      smallFileTexts,
      brandFileMatches,
      keywordFileMatches,
      fullRepoSecretCandidates,
    };

    // Authoritative brand attribution: checked AFTER real content is in hand,
    // against every monitored brand, not just whichever one superficially
    // matched this repo's name/description/topics before it was ever cloned.
    const best = findBestBrandMatch(brands, {
      ownerLogin: ctx.owner,
      repoName: ctx.name,
      description: ctx.description,
      topics: ctx.topics,
      filePaths: ctx.filePaths,
      readmeText: ctx.readmeText,
      fileTexts: ctx.smallFileTexts,
      fullRepoTextMatches: ctx.brandFileMatches,
    });
    if (best) {
      ctx.matchedBrandId = best.brand.id;
      ctx.matchedBrandName = best.brand.name;
      ctx.matchedBrandAliases = best.brand.aliases;
      ctx.matchedBrandTrustedOwners = best.brand.trustedGithubOwners;
      ctx.matchedBrandKeywords = best.brand.keywords;

      // Owner-account reputation only matters for judging whether this
      // looks like an impersonator's throwaway account, so it's only worth
      // the extra GitHub call once a brand has actually matched - not for
      // every repo in a scan. Also skipped when the owner is already one of
      // this brand's own known-trusted accounts: "is this a throwaway
      // account" is a meaningless question to ask about an account that's
      // already confirmed legitimate.
      const isTrustedOwner = (best.brand.trustedGithubOwners || []).some(
        (o) => o.toLowerCase() === ctx.owner.toLowerCase(),
      );
      if (!isTrustedOwner) {
        const profile = await this.github.getUserProfile(ctx.owner, requestCtx);
        if (profile) {
          ctx.ownerAccountCreatedAt = profile.createdAt
            ? new Date(profile.createdAt)
            : undefined;
          ctx.ownerFollowers = profile.followers;
          ctx.ownerPublicRepos = profile.publicRepos;
        }
      }
    }

    return { repositoryDbId: '', ctx };
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
      const commits = await this.github.listRecentCommits(
        owner,
        repo,
        headSha,
        maxCommits,
        requestCtx,
      );
      ctx.commitMessages = commits.map((c) => c.message).filter(Boolean);
      ctx.commitAuthors = commits.map((c) => c.authorName).filter(Boolean);

      for (const { sha } of commits) {
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
      /**
       * Discovery-only write: records the repo metadata GitHub's search
       * response already gave us (name/description/topics/dates/...) so it
       * shows up as a candidate, but deliberately skips every
       * analysis-outcome field (lastScannedAt, lastProcessingFailed,
       * lastSuccessfulScanAt, ...) and sets pendingAnalysis=true instead -
       * this repo hasn't actually been opened, cloned, or scanned yet, and
       * must not look like it has. Any other, non-discoveredOnly call
       * (i.e. every real analysis pass) always clears pendingAnalysis back
       * to false - this function is the single point where a repo
       * transitions from "just found" to "actually looked at."
       */
      discoveredOnly?: boolean;
      /**
       * Best-effort discovery-time match evidence (see
       * GitHubSearchProcessor.resolveDiscoveryMatchEvidence) - which field
       * (repo_name/description/topics) or, for a code-search hit, which
       * file (file_content + discoveryMatchedPath) actually contains the
       * scan's keyword. Only meaningful alongside discoveredOnly; a real
       * analysis pass gets exact evidence from a Finding instead and never
       * needs this.
       */
      discoveryMatchedField?: string;
      discoveryMatchedPath?: string;
      discoveryMatchedText?: string;
      /**
       * Which company/keyword's discovery scan found this repo, first-write-
       * wins - see Repository.discoveryBrandId. Only meaningful alongside
       * discoveredOnly; in practice this only ever fires once per repo since
       * the search processor skips repos it already knows about before
       * calling this again.
       */
      discoveryBrandId?: string;
      discoveryKeyword?: string;
      /**
       * Stamps Repository.origin - pass this whenever the caller knows it
       * (every real call site does, from its own job data), so origin stays
       * accurate across a repo's whole lifetime rather than only reflecting
       * whichever scan happened to run last. Left undefined only from a few
       * test call sites, where the schema's 'external' default applies on
       * insert and an existing doc's origin is simply left untouched.
       */
      internalAudit?: boolean;
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
      isDemo: false,
    };
    // Omitted entirely (not set to an Invalid Date) when GitHub genuinely
    // didn't give us a value - a code-search discovery's embedded repo
    // object never includes these (see GitHubRepoSearchItem.created_at);
    // the discovery processor already tries a direct fetch to backfill
    // created_at/pushed_at before this runs, but that can still come up
    // empty. Leaving the key out keeps a real value from an earlier write
    // intact instead of clobbering it with nothing on a later re-discovery.
    if (item.created_at) update.githubCreatedAt = new Date(item.created_at);
    if (item.updated_at) {
      update.githubUpdatedAt = new Date(item.updated_at);
    } else if (item.pushed_at) {
      update.githubUpdatedAt = new Date(item.pushed_at);
    }
    if (item.pushed_at) update.githubPushedAt = new Date(item.pushed_at);
    if (extras.discoveredOnly) {
      update.pendingAnalysis = true;
      // Cleared (not just left unset) whenever this discovery call has no
      // evidence to report - a repo re-discovered by a plain brand sweep
      // after an earlier keyword-scoped scan captured evidence must not go
      // on showing that stale evidence as if it still applies.
      update.discoveryMatchedField = extras.discoveryMatchedField || '';
      update.discoveryMatchedPath = extras.discoveryMatchedPath || '';
      update.discoveryMatchedText = extras.discoveryMatchedText || '';
      if (extras.discoveryBrandId) {
        update.discoveryBrandId = new Types.ObjectId(extras.discoveryBrandId);
      }
      if (extras.discoveryKeyword) {
        update.discoveryKeyword = extras.discoveryKeyword;
      }
    } else {
      update.pendingAnalysis = false;
      update.lastScannedAt = new Date();
    }
    if (extras.internalAudit !== undefined) {
      update.origin = extras.internalAudit ? 'internal' : 'external';
    }
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

  /**
   * Narrow, single-field counterpart to upsertRepository's `pendingAnalysis
   * = false` branch, for ScanMode.BRANCH_ANALYSIS - see
   * BranchAnalysisProcessor. That processor deliberately never calls
   * upsertRepository (a full-document overwrite using a synthetic,
   * mostly-empty repo item, since the real metadata isn't refetched for an
   * ad-hoc single-branch scan - it would stomp the repo's real
   * stars/forks/description with zeros/nulls) or touch defaultBranch/
   * lastProcessedCommitSha/lastScannedAt (which would corrupt the normal
   * default-branch incremental-rescan decision this exact repo also goes
   * through independently). But a repo discovered by a discoveryOnly scan
   * and never otherwise analyzed stays pendingAnalysis=true forever
   * otherwise - and FindingsService.list() unconditionally excludes any
   * Finding whose repo is still pendingAnalysis=true, so a branch-analysis
   * finding would silently never appear on the Findings page. Clearing
   * just this one field is enough to fix that without touching anything
   * default-branch-specific.
   */
  async clearPendingAnalysis(
    workspaceId: string,
    repositoryDbId: string,
  ): Promise<void> {
    await this.repoModel.updateOne(
      {
        _id: new Types.ObjectId(repositoryDbId),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      { $set: { pendingAnalysis: false } },
    );
  }

  /**
   * Whether this repo's owner already has OTHER repos in this workspace
   * with findings against a *different* monitored brand - a single flagged
   * repo could be coincidence, but the same account hitting multiple
   * distinct brands is a real behavioral fingerprint of a repeat operator.
   * False-positive-triaged findings don't count toward this - an analyst
   * already decided that repo wasn't a real match, so it shouldn't lend
   * false weight to a genuinely separate one just because it's the same
   * account.
   */
  private async getOperatorContext(
    workspaceId: Types.ObjectId,
    owner: string,
    excludeGithubId: number,
  ): Promise<OperatorContext> {
    const otherRepos = await this.repoModel
      .find({
        workspaceId,
        owner,
        githubId: { $ne: excludeGithubId },
      })
      .select('_id')
      .lean()
      .exec();
    if (otherRepos.length === 0) return { otherBrandsHit: 0 };

    const otherFindings = await this.findingModel
      .find({
        workspaceId,
        repositoryId: { $in: otherRepos.map((r) => r._id) },
        status: { $ne: FindingStatus.FALSE_POSITIVE },
      })
      .select('brandName')
      .lean()
      .exec();
    const distinctBrands = new Set(
      otherFindings.map((f) => f.brandName).filter(Boolean),
    );
    return { otherBrandsHit: distinctBrands.size };
  }

  /**
   * Replaces this repo's stored fingerprint set with exactly what this scan
   * found. Upserting the current ones first (before deleting anything stale)
   * mirrors the detection insert/delete ordering below - a crash mid-way
   * should never leave a repo with zero recorded evidence.
   */
  // Bounded so one repo's liveness pass can't run indefinitely - a handful
  // of distinct destinations plus a Pages check is plenty of evidence.
  private static readonly MAX_LIVENESS_CHECKS = 3;

  /**
   * The actual "proof of harm" step: independently confirms whether a
   * suspect repo is a live, active operation right now, not just source
   * code sitting unused. Checks (a) every distinct external destination its
   * own code sends data to (see extractDataDestinations) and (b) whether it
   * has a live GitHub Pages deployment. Both are read-only existence checks
   * - no credentials sent, no content stored - and both fail closed on any
   * error, so a dead/unreachable destination is silently just not reported,
   * never a thrown error that could break the rest of the scan.
   */
  private async checkLiveness(
    ctx: RepoAnalysisContext,
    workspaceId: string,
    scanJobId: string,
  ): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];
    const destinations = extractDataDestinations(ctx).slice(
      0,
      ScanPipelineService.MAX_LIVENESS_CHECKS,
    );

    const [destinationLiveness, pagesInfo] = await Promise.all([
      Promise.all(destinations.map((d) => checkUrlLiveness(d.url))),
      this.github
        .getRepositoryPagesInfo(ctx.owner, ctx.name, { workspaceId, scanJobId })
        .catch(() => null),
    ]);

    destinationLiveness.forEach((live, i) => {
      if (!live?.live) return;
      const d = destinations[i];
      results.push({
        ruleId: 'confirmed-live-destination',
        ruleName: 'Confirmed Live Destination',
        category: ThreatCategory.CONFIRMED_LIVE,
        severity: Severity.CRITICAL,
        confidence: 0.9,
        evidence: `The destination "${d.hostname}" this repo's own code sends data to is live and responding right now (HTTP ${live.statusCode}) - not dormant source code, an active endpoint.`,
        explanation:
          'Independently confirmed reachable via a direct request - this destination is actually listening, not just referenced in code.',
        riskContribution: 30,
        matchedText: live.url,
      });
    });

    if (pagesInfo) {
      const pagesLive = await checkUrlLiveness(pagesInfo.url);
      if (pagesLive?.live) {
        results.push({
          ruleId: 'confirmed-live-pages',
          ruleName: 'Confirmed Live GitHub Pages Deployment',
          category: ThreatCategory.CONFIRMED_LIVE,
          severity: Severity.CRITICAL,
          confidence: 0.95,
          evidence: `This repository is deployed and live right now at ${pagesInfo.url} (GitHub Pages) - not just source code, an active, reachable site.`,
          explanation:
            'GitHub Pages deployment independently confirmed live and reachable - direct proof of an active site, not dormant code.',
          riskContribution: 32,
          matchedText: pagesInfo.url,
        });
      }
    }

    return results;
  }

  private async persistFingerprints(
    workspaceId: Types.ObjectId,
    repositoryId: Types.ObjectId,
    owner: string,
    fullName: string,
    fingerprints: ExtractedFingerprint[],
  ): Promise<void> {
    for (const f of fingerprints) {
      await this.fingerprintModel.findOneAndUpdate(
        { workspaceId, repositoryId, kind: f.kind, value: f.value },
        { $set: { owner, fullName, lastSeenAt: new Date() } },
        { upsert: true },
      );
    }
    await this.fingerprintModel.deleteMany({
      workspaceId,
      repositoryId,
      ...(fingerprints.length > 0
        ? { $nor: fingerprints.map((f) => ({ kind: f.kind, value: f.value })) }
        : {}),
    });
  }

  /**
   * Deployment URL + contributor roster, straight from GitHub's REST API -
   * unlike fingerprints/detection this needs no cloned file content, so it's
   * called directly from RepositoryAnalysisProcessor rather than routed
   * through the detection queue. Best-effort: a GitHub API hiccup here
   * shouldn't fail the whole analysis pass, so callers should catch around
   * this rather than let it propagate.
   */
  async persistDeploymentAndContributors(
    workspaceId: Types.ObjectId,
    repositoryId: Types.ObjectId,
    owner: string,
    fullName: string,
    deployment: RepositoryDeployment | null,
    contributors: Array<{
      login: string;
      avatarUrl?: string;
      contributions: number;
    }>,
  ): Promise<void> {
    await this.repoModel.updateOne(
      { _id: repositoryId },
      { $set: { deployment: deployment || null } },
    );
    if (!this.contributorModel) return;
    for (const c of contributors) {
      await this.contributorModel.findOneAndUpdate(
        { workspaceId, repositoryId, login: c.login },
        {
          $set: {
            owner,
            fullName,
            avatarUrl: c.avatarUrl,
            contributions: c.contributions,
            lastSeenAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
    await this.contributorModel.deleteMany({
      workspaceId,
      repositoryId,
      ...(contributors.length > 0
        ? { login: { $nin: contributors.map((c) => c.login) } }
        : {}),
    });
  }

  /**
   * How many *other* GitHub owners in this workspace share one of this
   * repo's own contact/wallet fingerprints - the cross-identity analogue of
   * getOperatorContext above, except it isn't limited to repos with the same
   * owner login. Same false-positive exclusion: a link an analyst already
   * dismissed on the other repo shouldn't keep inflating this one's score.
   */
  private async getCrossIdentityContext(
    workspaceId: Types.ObjectId,
    owner: string,
    fingerprints: ExtractedFingerprint[],
  ): Promise<{ linkedIdentityOwners: number }> {
    if (fingerprints.length === 0) return { linkedIdentityOwners: 0 };

    const matches = await this.fingerprintModel
      .find({
        workspaceId,
        owner: { $ne: owner },
        $or: fingerprints.map((f) => ({ kind: f.kind, value: f.value })),
      })
      .select('owner repositoryId')
      .lean()
      .exec();
    if (matches.length === 0) return { linkedIdentityOwners: 0 };

    const repoIds = [
      ...new Set(matches.map((m) => String(m.repositoryId))),
    ].map((id) => new Types.ObjectId(id));
    const activeFindings = await this.findingModel
      .find({
        workspaceId,
        repositoryId: { $in: repoIds },
        status: { $ne: FindingStatus.FALSE_POSITIVE },
      })
      .select('repositoryId')
      .lean()
      .exec();
    const activeRepoIds = new Set(
      activeFindings.map((f) => String(f.repositoryId)),
    );
    const linkedOwners = new Set(
      matches
        .filter((m) => activeRepoIds.has(String(m.repositoryId)))
        .map((m) => m.owner),
    );
    return { linkedIdentityOwners: linkedOwners.size };
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
    internalAudit?: boolean;
    /**
     * Set only for ScanMode.BRANCH_ANALYSIS - scanning one specific
     * non-default branch on demand. Tags any created/updated Finding with
     * where it was seen (Finding.branch), and - critically - skips
     * resolveMissingFindings below: that step marks every OTHER open
     * finding for this repo as resolved if this scan didn't re-see it,
     * which is correct for a normal full-repo scan (which sees everything)
     * but would be wrong here - a side-branch scan only ever sees that one
     * branch's subset of findings, so treating "not seen on this branch" as
     * "resolved" would incorrectly close out genuine default-branch
     * findings this scan never even looked at.
     */
    branch?: string;
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
    const detections = this.detectionEngine.analyze(
      input.ctx,
      input.internalAudit
        ? { excludeRuleIds: IMPERSONATION_ONLY_RULE_IDS }
        : {},
    );

    // Reuse checks (credential / content / file): only meaningful for
    // external candidates checked against a specific brand's own reference
    // data - an internal audit of the brand's own repos would just be
    // matching the brand against itself, which isn't "reuse" by anyone.
    if (!input.internalAudit && input.brandId) {
      const brandOid = new Types.ObjectId(input.brandId);

      if (this.knownSecretModel) {
        const known = await this.knownSecretModel
          .find({ workspaceId: ws, brandId: brandOid }, { valueHash: 1 })
          .lean()
          .exec();
        if (known.length > 0) {
          const knownHashes = new Set(known.map((k) => k.valueHash));
          const reuseMatches = findCredentialReuseMatches(
            input.ctx,
            knownHashes,
          );
          for (const m of reuseMatches) {
            const reuseDetection: DetectionResult = {
              ruleId: 'credential-reuse',
              ruleName: 'Reused Client Credential',
              category: ThreatCategory.CREDENTIAL_REUSE,
              severity: Severity.CRITICAL,
              confidence: 0.99,
              evidence: m.evidence,
              explanation: `Contains a credential value (${m.patternName}) that exactly matches one previously found in the brand's own reference repositories - not merely a secret of the same type, but the same value.`,
              riskContribution: 40,
              file: m.file,
              lineNumber: m.lineNumber,
            };
            detections.push(reuseDetection);
          }
        }
      }

      if (this.contentStringModel) {
        const phraseRows = await this.contentStringModel
          .find({ workspaceId: ws, brandId: brandOid }, { text: 1 })
          .lean()
          .exec();
        if (phraseRows.length > 0) {
          const phraseMatches = findPhraseReuseMatches(
            input.ctx,
            phraseRows.map((r) => r.text),
          );
          for (const m of phraseMatches) {
            const phraseDetection: DetectionResult = {
              ruleId: 'content-reuse-phrase',
              ruleName: 'Reused Client Content',
              category: ThreatCategory.CONTENT_REUSE,
              severity: Severity.HIGH,
              confidence: 0.75,
              evidence: m.evidence,
              explanation:
                "Contains wording that exactly matches distinctive content from the brand's own reference repositories.",
              riskContribution: 22,
              file: m.file,
              lineNumber: m.lineNumber,
              matchedText: m.matchedText,
            };
            detections.push(phraseDetection);
          }
        }
      }

      if (this.codeFingerprintModel) {
        const hashRows = await this.codeFingerprintModel
          .find({ workspaceId: ws, brandId: brandOid }, { contentHash: 1 })
          .lean()
          .exec();
        if (hashRows.length > 0) {
          const knownFileHashes = new Set(hashRows.map((r) => r.contentHash));
          const fileMatches = findFileHashReuseMatches(
            input.ctx,
            knownFileHashes,
          );
          for (const m of fileMatches) {
            const fileDetection: DetectionResult = {
              ruleId: 'content-reuse-file',
              ruleName: 'Copied Client File',
              category: ThreatCategory.CONTENT_REUSE,
              severity: Severity.CRITICAL,
              confidence: 0.95,
              evidence: m.evidence,
              explanation:
                "Contains a file that is byte-for-byte identical to one in the brand's own reference repositories - not similar, an exact copy.",
              riskContribution: 35,
              file: m.file,
            };
            detections.push(fileDetection);
          }
        }
      }
    }

    const meaningful = detections.filter(
      (d) => d.ruleId !== 'low-reputation-new-repo',
    );

    // Liveness confirmation: the actual "proof of harm" step - only worth
    // the network calls once something else has already flagged this repo
    // as worth a second look. External-scan candidates only; an internal
    // audit already knows these are the brand's own real repos, so "is it
    // live" answers nothing useful there.
    if (!input.internalAudit && meaningful.length > 0) {
      const liveDetections = await this.checkLiveness(
        input.ctx,
        input.workspaceId,
        input.scanJobId,
      );
      detections.push(...liveDetections);
    }

    const empty = {
      created: 0,
      updated: 0,
      findingsNew: 0,
      findingsUnchanged: 0,
      findingsReopened: 0,
      findingsResolved: 0,
      shouldAlert: false,
    };

    // Kept in sync every scan regardless of whether this repo currently
    // trips a rule - a repo can carry a real contact/wallet fingerprint
    // worth cross-referencing even on a scan that otherwise found nothing,
    // and one that used to be flagged but no longer is shouldn't keep
    // contributing a stale link to some other repo's score.
    const fingerprints = extractOperatorFingerprints(input.ctx);
    await this.persistFingerprints(
      ws,
      repoOid,
      input.ctx.owner,
      input.fullName,
      fingerprints,
    );

    if (meaningful.length === 0) {
      // See input.branch's doc comment above - a branch-scoped scan finding
      // nothing on that one branch says nothing about whether the repo's
      // OTHER (default-branch) findings still stand, so it must not resolve
      // any of them.
      const resolved = input.branch
        ? 0
        : await this.resolveMissingFindings(
            ws,
            repoOid,
            input.scanJobId,
            new Set(),
          );
      return { ...empty, findingsResolved: resolved };
    }

    const [operatorContext, crossIdentity] = await Promise.all([
      this.getOperatorContext(ws, input.ctx.owner, input.githubId),
      this.getCrossIdentityContext(ws, input.ctx.owner, fingerprints),
    ]);
    const risk = this.riskScoring.calculate(detections, input.ctx, {
      ...operatorContext,
      ...crossIdentity,
    });
    // Not just "does this mention the brand" but "where, and how strongly" -
    // an exact hit in the repo's own name is very different evidence from a
    // fuzzy word buried in one file, and both are very different from a
    // verified trusted-owner match. Recomputed here (rather than trusted
    // from discovery time) because by now the full README/file content -
    // and commit history, if that scan ran - is available to check too.
    const brandMatchEvidence = input.ctx.matchedBrandName
      ? findBrandMatch(
          {
            name: input.ctx.matchedBrandName,
            aliases: input.ctx.matchedBrandAliases || [],
            trustedGithubOwners: input.ctx.matchedBrandTrustedOwners || [],
          },
          {
            ownerLogin: input.ctx.owner,
            repoName: input.ctx.name,
            description: input.ctx.description,
            topics: input.ctx.topics,
            filePaths: input.ctx.filePaths,
            readmeText: input.ctx.readmeText,
            fileTexts: input.ctx.smallFileTexts,
            fullRepoTextMatches: input.ctx.brandFileMatches,
            commitMessages: input.ctx.commitMessages,
            commitAuthors: input.ctx.commitAuthors,
          },
        )
      : null;
    // brand-impersonation now finds and sets its own file/line directly
    // (see collectProximityUnits in threat.rules.ts) - it's the exact place
    // the brand name AND a suspicious term were found together, which is
    // not necessarily the same place brandMatchEvidence below points to
    // (that's just "where does the brand name appear at all," a much
    // weaker claim). Deliberately NOT backfilled from brandMatchEvidence
    // when the rule left file/line unset (a metadata-only match, in the
    // repo name/description/topics) - doing so used to attach a real but
    // unrelated file/line to a metadata-level match, which is how a repo's
    // one-off blog mention of a brand name and a same-page but unrelated
    // "login" button ended up displayed as if they were found together on
    // one specific line.
    const fingerprint = this.fingerprint(
      input.githubId,
      detections.map((d) => d.ruleId),
      input.branch,
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
    // How many distinct curated keywords matched - see customKeywordMatchRule,
    // which emits one 'custom-keyword-match' detection per matched keyword.
    const keywordMatchCount = detections.filter(
      (d) => d.ruleId === 'custom-keyword-match',
    ).length;

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
      existing.keywordMatchCount = keywordMatchCount;
      existing.riskBreakdown = risk.breakdown;
      existing.summary = summary;
      existing.lastSeenAt = new Date();
      existing.lastScanJobId = new Types.ObjectId(input.scanJobId);
      existing.origin = input.internalAudit ? 'internal' : 'external';
      existing.branch = input.branch;
      if (input.brandId) {
        existing.brandId = new Types.ObjectId(input.brandId);
        existing.brandName = input.brandName;
        existing.brandMatchEvidence = brandMatchEvidence || undefined;
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
    } else {
      finding = await this.findingModel.create({
        workspaceId: ws,
        repositoryId: repoOid,
        brandId: input.brandId ? new Types.ObjectId(input.brandId) : undefined,
        brandName: input.brandName,
        brandMatchEvidence: brandMatchEvidence || undefined,
        origin: input.internalAudit ? 'internal' : 'external',
        fingerprint,
        severity: risk.severity,
        riskScore: risk.score,
        categories: [...new Set(detections.map((d) => d.category))],
        keywordMatchCount,
        riskBreakdown: risk.breakdown,
        summary,
        status: FindingStatus.OPEN,
        lastChangeType: FindingChangeType.NEW,
        lastScanJobId: new Types.ObjectId(input.scanJobId),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        isDemo: false,
        branch: input.branch,
      });
      created = 1;
      findingsNew = 1;
    }

    // Insert the fresh detections *before* removing the old ones. If the
    // insert throws for any reason (a bad document, a transient Mongo
    // error), the finding must not end up with zero supporting evidence -
    // deleting first and inserting second can leave exactly that state,
    // since the finding's own metadata above is already saved by then.
    const inserted = await this.detectionModel.insertMany(
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
    await this.detectionModel.deleteMany({
      findingId: finding._id,
      workspaceId: ws,
      _id: { $nin: inserted.map((d) => d._id) },
    });

    // See input.branch's doc comment above - a branch-scoped scan only ever
    // sees that one branch's subset of findings, so it must never resolve
    // findings this scan didn't look at.
    const findingsResolved = input.branch
      ? 0
      : await this.resolveMissingFindings(
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

  private fingerprint(
    githubId: number,
    ruleIds: string[],
    branch?: string,
  ): string {
    // Deliberately omits branch entirely (not even an empty placeholder
    // segment) when unset, so every normal default-branch scan's fingerprint
    // format is byte-for-byte identical to before this field existed - a
    // format change here would silently mismatch every already-stored
    // Finding's fingerprint on its next scan and mass-duplicate the entire
    // findings table. Only ScanMode.BRANCH_ANALYSIS ever passes a branch,
    // giving that one code path its own fingerprint namespace so a
    // side-branch finding can never collide with (and overwrite the
    // evidence of) the repo's real default-branch finding, even if both
    // happen to trigger the exact same set of rule IDs.
    const payload = branch
      ? `${githubId}:${branch}:${[...ruleIds].sort().join(',')}`
      : `${githubId}:${[...ruleIds].sort().join(',')}`;
    return createHash('sha256').update(payload).digest('hex').slice(0, 32);
  }
}
