import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import {
  CodeFingerprint,
  CodeFingerprintDocument,
} from './schemas/code-fingerprint.schema';
import {
  DistinctiveContentString,
  DistinctiveContentStringDocument,
} from './schemas/distinctive-content-string.schema';
import {
  KnownClientSecret,
  KnownClientSecretDocument,
} from './schemas/known-client-secret.schema';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../brands/schemas/monitored-brand.schema';
import {
  buildCloneUrl,
  checkoutPaths,
  cloneShallow,
  getHeadSha,
  isGitAvailable,
  listTree,
  readFileCapped,
} from './git-repo.util';
import { isExcludedPath } from '../scans/clone-scan.service';
import { computeChunkFingerprints, hashContent } from './code-fingerprint.util';
import { classifyContentFile } from './content-file-classifier.util';
import { extractDistinctivePhrases } from './distinctive-content.util';
import { extractSecretValueHashes } from './known-secret.util';

export interface ReferenceIngestResult {
  owner: string;
  repo: string;
  commitSha: string;
  totalTreeFiles: number;
  filesIngested: number;
  filesSkipped: number;
  truncatedByFileCap: boolean;
  distinctivePhrasesStored: number;
  knownSecretsStored: number;
}

export interface ReferenceRepoSummary {
  owner: string;
  repo: string;
  fileCount: number;
  commitSha: string;
  lastIngestedAt: Date;
}

/** How many paths go into a single `git checkout` call - keeps argv length well under OS limits even for large repos. */
const CHECKOUT_BATCH_SIZE = 300;

/**
 * Builds the "ground truth" fingerprint corpus for a brand's own code:
 * clones a reference repo the client actually owns, walks its full tree
 * (not the priority-capped subset CloneScanService reads for secret
 * scanning), and stores content + chunk-shingle hashes per file. This is
 * the prerequisite external-audit comparison relies on - nothing can be
 * flagged as "a clone of our client's code" without this baseline.
 */
@Injectable()
export class ReferenceFingerprintService {
  private readonly logger = new Logger(ReferenceFingerprintService.name);

  constructor(
    @InjectModel(CodeFingerprint.name)
    private readonly fingerprintModel: Model<CodeFingerprintDocument>,
    @InjectModel(DistinctiveContentString.name)
    private readonly contentStringModel: Model<DistinctiveContentStringDocument>,
    @InjectModel(KnownClientSecret.name)
    private readonly knownSecretModel: Model<KnownClientSecretDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    private readonly config: ConfigService,
  ) {}

  private async assertBrandInWorkspace(
    workspaceId: string,
    brandId: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(brandId)) {
      throw new NotFoundException('Brand not found');
    }
    const exists = await this.brandModel
      .exists({ _id: brandId, workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!exists) throw new NotFoundException('Brand not found');
  }

  async ingestReferenceRepo(
    workspaceId: string,
    brandId: string,
    owner: string,
    repo: string,
  ): Promise<ReferenceIngestResult> {
    await this.assertBrandInWorkspace(workspaceId, brandId);

    if (!(await isGitAvailable())) {
      throw new ServiceUnavailableException(
        'git binary is not available on this server - reference ingestion requires it',
      );
    }

    const timeoutMs = Number(
      this.config.get('REFERENCE_INGEST_TIMEOUT_MS') || 60_000,
    );
    const maxFiles = Number(
      this.config.get('REFERENCE_INGEST_MAX_FILES') || 5000,
    );
    const maxFileBytes = Number(
      this.config.get('REFERENCE_INGEST_MAX_FILE_BYTES') || 204_800,
    );
    const maxPhrasesPerFile = Number(
      this.config.get('REFERENCE_INGEST_MAX_PHRASES_PER_FILE') || 20,
    );
    const token = this.config.get<string>('GITHUB_TOKEN');

    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'osint-refingest-'));
      const url = buildCloneUrl(owner, repo, token);

      try {
        await cloneShallow(url, dir, timeoutMs);
      } catch (error) {
        throw new BadRequestException(
          `Failed to clone ${owner}/${repo}: ${(error as Error).message}`,
        );
      }

      const allPaths = (await listTree(dir, timeoutMs)).filter(
        (p) => !isExcludedPath(p),
      );
      const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));
      const truncatedByFileCap = sortedPaths.length > maxFiles;
      const selected = sortedPaths.slice(0, maxFiles);
      if (truncatedByFileCap) {
        this.logger.warn(
          `Reference ingestion for ${owner}/${repo} truncated at ${maxFiles} files (tree has ${sortedPaths.length}) - increase REFERENCE_INGEST_MAX_FILES to cover the rest`,
        );
      }

      for (let i = 0; i < selected.length; i += CHECKOUT_BATCH_SIZE) {
        await checkoutPaths(
          dir,
          selected.slice(i, i + CHECKOUT_BATCH_SIZE),
          timeoutMs,
        );
      }

      const commitSha = await getHeadSha(dir, timeoutMs);
      const ingestedAt = new Date();

      const wsId = new Types.ObjectId(workspaceId);
      const brId = new Types.ObjectId(brandId);

      let filesIngested = 0;
      let filesSkipped = 0;
      let distinctivePhrasesStored = 0;
      let knownSecretsStored = 0;
      const currentFilePaths: string[] = [];

      for (const relPath of selected) {
        const content = await readFileCapped(join(dir, relPath), maxFileBytes);
        if (content === null) {
          filesSkipped += 1;
          continue;
        }
        const contentHash = hashContent(content);
        const chunkHashes = computeChunkFingerprints(content);
        await this.fingerprintModel.updateOne(
          {
            workspaceId: wsId,
            brandId: brId,
            sourceOwner: owner,
            sourceRepo: repo,
            filePath: relPath,
          },
          {
            $set: {
              contentHash,
              chunkHashes,
              fileSizeBytes: Buffer.byteLength(content, 'utf8'),
              commitSha,
              ingestedAt,
            },
          },
          { upsert: true },
        );
        currentFilePaths.push(relPath);
        filesIngested += 1;

        // Distinctive-content bait strings: only from files classified as
        // content-bearing (locale/template/legal/docs), not every file -
        // see content-file-classifier.util.ts for why.
        const category = classifyContentFile(relPath);
        if (category) {
          const phrases = extractDistinctivePhrases(content).slice(
            0,
            maxPhrasesPerFile,
          );
          for (const phrase of phrases) {
            await this.contentStringModel.updateOne(
              {
                workspaceId: wsId,
                brandId: brId,
                sourceOwner: owner,
                sourceRepo: repo,
                filePath: relPath,
                text: phrase.text,
              },
              {
                $set: {
                  category,
                  significantWordCount: phrase.significantWordCount,
                  ingestedAt,
                },
              },
              { upsert: true },
            );
            distinctivePhrasesStored += 1;
          }
          // Drop phrases previously stored for this exact file that no
          // longer appear in its current content (edited/removed copy).
          await this.contentStringModel.deleteMany({
            workspaceId: wsId,
            brandId: brId,
            sourceOwner: owner,
            sourceRepo: repo,
            filePath: relPath,
            text: { $nin: phrases.map((p) => p.text) },
          });
        }

        // Known-secret hashes: scanned across every file (a leaked
        // credential isn't confined to "content" files), never pruned - see
        // known-client-secret.schema.ts for why.
        for (const secret of extractSecretValueHashes(content)) {
          await this.knownSecretModel.updateOne(
            { workspaceId: wsId, brandId: brId, valueHash: secret.valueHash },
            {
              $set: {
                sourceOwner: owner,
                sourceRepo: repo,
                filePath: relPath,
                patternId: secret.patternId,
                patternName: secret.patternName,
                lastSeenAt: ingestedAt,
              },
            },
            { upsert: true },
          );
          knownSecretsStored += 1;
        }
      }

      // Drop fingerprints (and their content-string bait) for files no
      // longer present (renamed/deleted/now binary) so re-ingestion
      // replaces the corpus rather than accreting.
      await this.fingerprintModel.deleteMany({
        workspaceId: wsId,
        brandId: brId,
        sourceOwner: owner,
        sourceRepo: repo,
        filePath: { $nin: currentFilePaths },
      });
      await this.contentStringModel.deleteMany({
        workspaceId: wsId,
        brandId: brId,
        sourceOwner: owner,
        sourceRepo: repo,
        filePath: { $nin: currentFilePaths },
      });

      return {
        owner,
        repo,
        commitSha,
        totalTreeFiles: allPaths.length,
        filesIngested,
        filesSkipped,
        truncatedByFileCap,
        distinctivePhrasesStored,
        knownSecretsStored,
      };
    } finally {
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async listReferenceRepos(
    workspaceId: string,
    brandId: string,
  ): Promise<ReferenceRepoSummary[]> {
    await this.assertBrandInWorkspace(workspaceId, brandId);
    const rows = await this.fingerprintModel.aggregate<{
      _id: { sourceOwner: string; sourceRepo: string };
      fileCount: number;
      commitSha: string;
      lastIngestedAt: Date;
    }>([
      {
        $match: {
          workspaceId: new Types.ObjectId(workspaceId),
          brandId: new Types.ObjectId(brandId),
        },
      },
      { $sort: { ingestedAt: -1 } },
      {
        $group: {
          _id: { sourceOwner: '$sourceOwner', sourceRepo: '$sourceRepo' },
          fileCount: { $sum: 1 },
          commitSha: { $first: '$commitSha' },
          lastIngestedAt: { $first: '$ingestedAt' },
        },
      },
    ]);

    return rows
      .map((r) => ({
        owner: r._id.sourceOwner,
        repo: r._id.sourceRepo,
        fileCount: r.fileCount,
        commitSha: r.commitSha,
        lastIngestedAt: r.lastIngestedAt,
      }))
      .sort((a, b) =>
        `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
      );
  }

  async removeReferenceRepo(
    workspaceId: string,
    brandId: string,
    owner: string,
    repo: string,
  ): Promise<{ deletedCount: number }> {
    await this.assertBrandInWorkspace(workspaceId, brandId);
    const wsId = new Types.ObjectId(workspaceId);
    const brId = new Types.ObjectId(brandId);
    const result = await this.fingerprintModel.deleteMany({
      workspaceId: wsId,
      brandId: brId,
      sourceOwner: owner,
      sourceRepo: repo,
    });
    // Content-string bait is repo-specific data, cleaned up alongside the
    // fingerprints it came from. Known-secret hashes are deliberately left
    // in place - see known-client-secret.schema.ts.
    await this.contentStringModel.deleteMany({
      workspaceId: wsId,
      brandId: brId,
      sourceOwner: owner,
      sourceRepo: repo,
    });
    if (result.deletedCount === 0) {
      throw new NotFoundException('Reference repo not found for this brand');
    }
    return { deletedCount: result.deletedCount };
  }
}
