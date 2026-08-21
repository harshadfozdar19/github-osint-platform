import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitHubService } from '../github/github.service';
import { GitHubRequestContext } from '../github/github-rate-limit.types';
import { redactSecretsInText } from '../common/utils/redact';
import { DeepIntentContext } from './providers/intent-provider.interface';

/**
 * Builds the small, bounded, pre-redacted slice of a repository's actual
 * content used for a Tier-2 "deep review" pass - only ever assembled for
 * findings Tier 1 couldn't confidently resolve. Every read goes through
 * GitHubService's existing bounded/safe methods (getReadme, listRootPaths,
 * getSmallTextFile) - no new GitHub client code, no arbitrary file access,
 * and every text field is redacted before it's ever placed in a prompt sent
 * to an external provider.
 */
@Injectable()
export class DeepIntentContextBuilder {
  constructor(
    private readonly config: ConfigService,
    private readonly github: GitHubService,
  ) {}

  async build(
    workspaceId: string,
    repo: { owner: string; name: string },
    detectionFiles: Array<string | undefined>,
  ): Promise<DeepIntentContext> {
    const readmeMaxChars = Number(
      this.config.get('INTELLIGENCE_DEEP_REVIEW_README_MAX_CHARS') || 3000,
    );
    const maxFiles = Number(
      this.config.get('INTELLIGENCE_DEEP_REVIEW_MAX_FILES') || 3,
    );
    const totalMaxChars = Number(
      this.config.get('INTELLIGENCE_DEEP_REVIEW_MAX_TOTAL_CHARS') || 8000,
    );
    const ctx: GitHubRequestContext = { workspaceId };

    const [readmeRaw, rootPathsRaw] = await Promise.all([
      this.github
        .getReadme(repo.owner, repo.name, ctx)
        .catch(() => ({ text: '', path: undefined as string | undefined })),
      this.github.listRootPaths(repo.owner, repo.name, ctx).catch(() => []),
    ]);

    const rootPaths = rootPathsRaw.slice(0, 60);

    const readme: DeepIntentContext['readme'] = readmeRaw.text
      ? {
          path: readmeRaw.path,
          text: redactSecretsInText(readmeRaw.text.slice(0, readmeMaxChars)),
          truncated: readmeRaw.text.length > readmeMaxChars,
        }
      : undefined;

    let manifest: DeepIntentContext['manifest'];
    const manifestPath = rootPaths.find((p) => p === 'package.json');
    if (manifestPath) {
      const text = await this.github
        .getSmallTextFile(repo.owner, repo.name, manifestPath, ctx)
        .catch(() => null);
      if (text)
        manifest = { path: manifestPath, text: redactSecretsInText(text) };
    }

    const flaggedPaths = [
      ...new Set(detectionFiles.filter((f): f is string => !!f)),
    ].slice(0, maxFiles);
    const flaggedFiles: DeepIntentContext['flaggedFiles'] = [];
    for (const path of flaggedPaths) {
      const text = await this.github
        .getSmallTextFile(repo.owner, repo.name, path, ctx)
        .catch(() => null);
      if (text) flaggedFiles.push({ path, text: redactSecretsInText(text) });
    }

    return this.enforceTotalCap(
      { readme, rootPaths, manifest, flaggedFiles },
      totalMaxChars,
    );
  }

  /**
   * Caps the combined size of everything pulled above, truncating lowest-
   * priority content first: flagged files (the rule engine's own pointer to
   * what matters) > README > manifest > the file tree (just path names,
   * cheapest to drop last).
   */
  private enforceTotalCap(
    deep: DeepIntentContext,
    totalMaxChars: number,
  ): DeepIntentContext {
    let budget = totalMaxChars;
    const take = (text: string): string => {
      if (budget <= 0) return '';
      const taken = text.slice(0, budget);
      budget -= taken.length;
      return taken;
    };

    const flaggedFiles = deep.flaggedFiles
      .map((f) => ({ ...f, text: take(f.text) }))
      .filter((f) => f.text.length > 0);

    let readme = deep.readme;
    if (readme) {
      const originalLength = readme.text.length;
      const text = take(readme.text);
      readme =
        text.length > 0
          ? {
              ...readme,
              text,
              truncated: readme.truncated || text.length < originalLength,
            }
          : undefined;
    }

    let manifest = deep.manifest;
    if (manifest) {
      const text = take(manifest.text);
      manifest = text.length > 0 ? { ...manifest, text } : undefined;
    }

    const rootPaths = budget > 0 ? deep.rootPaths : undefined;

    return { readme, rootPaths, manifest, flaggedFiles };
  }
}
