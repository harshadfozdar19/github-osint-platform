import { spawn } from 'child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pathPriority, TEXT_FILE_RE } from './scan-pipeline.service';

/**
 * Directories never worth walking into: dependency trees, build output, VCS
 * internals. Skipping these outright is what makes a full-repo clone+scan
 * viable instead of grinding through thousands of irrelevant files.
 */
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  'coverage',
  '.cache',
  'bower_components',
  '.gradle',
  '.idea',
  '.vscode',
]);

export interface CloneScanResult {
  filePaths: string[];
  readmeText: string;
  smallFileTexts: Array<{ path: string; content: string }>;
}

export interface RemoteHead {
  sha: string;
  defaultBranch?: string;
}

/**
 * Parses `git ls-remote --symref <url> HEAD` output, e.g.:
 *   ref: refs/heads/main	HEAD
 *   3f2504e0...c3a1	HEAD
 * Exported standalone so parsing logic can be unit tested without spawning
 * a real git process.
 */
export function parseLsRemoteHead(stdout: string): RemoteHead | null {
  let defaultBranch: string | undefined;
  let sha: string | undefined;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('ref:')) {
      const match = /ref:\s+refs\/heads\/(\S+)/.exec(line);
      if (match) defaultBranch = match[1];
      continue;
    }
    const [maybeSha, ref] = line.split(/\s+/);
    if (ref === 'HEAD' && /^[0-9a-f]{40}$/i.test(maybeSha)) {
      sha = maybeSha;
    }
  }
  return sha ? { sha, defaultBranch } : null;
}

/**
 * Alternative to per-file REST content fetching: shallow-clones a public repo
 * over git's own transport (no GitHub REST rate limit involved at all) and
 * scans the full working tree locally. Opt-in via ENABLE_CLONE_SCAN, and
 * fails closed — any error here just returns null so the caller falls back
 * to the existing REST-based fetch instead of breaking the scan.
 */
@Injectable()
export class CloneScanService {
  private readonly logger = new Logger(CloneScanService.name);
  private gitAvailable: boolean | null = null;

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    // Default-on: bypasses the GitHub REST client (and all of its Redis
    // rate-limit/concurrency bookkeeping) entirely for eligible repos, which
    // is what keeps a large scan from burning through a metered Redis
    // plan's command budget. Fails closed either way, so an explicit
    // `false` (or a missing git binary at runtime) just falls back to the
    // existing REST-based fetch with no behavior change.
    const raw = this.config.get<string>('ENABLE_CLONE_SCAN');
    return raw === undefined || raw.toLowerCase() !== 'false';
  }

  async shouldAttempt(sizeKb: number | undefined): Promise<boolean> {
    if (!this.isEnabled()) return false;
    // Unknown size (e.g. resumed jobs that never captured it) - be
    // conservative and let the REST fallback handle it instead of cloning
    // something that could be arbitrarily large.
    if (sizeKb === undefined) return false;
    const maxKb = Number(
      this.config.get('CLONE_SCAN_MAX_REPO_SIZE_KB') || 51200,
    );
    if (sizeKb > maxKb) return false;
    return this.checkGitAvailable();
  }

  async cloneAndScan(
    owner: string,
    name: string,
  ): Promise<CloneScanResult | null> {
    const timeoutMs = Number(
      this.config.get('CLONE_SCAN_TIMEOUT_MS') || 30_000,
    );
    const maxFiles = Number(this.config.get('CLONE_SCAN_MAX_FILES') || 200);
    const maxFileBytes = Number(
      this.config.get('GITHUB_MAX_FILE_BYTES') || 51200,
    );

    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'osint-clone-'));
      const url = `https://github.com/${owner}/${name}.git`;
      await this.runGitClone(url, dir, timeoutMs);

      const filePaths: string[] = [];
      await this.walk(dir, dir, filePaths);

      const ranked = filePaths
        .map((p) => ({ path: p, score: pathPriority(p) }))
        .filter((p) => p.score > 0 && TEXT_FILE_RE.test(p.path))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

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

      const smallFileTexts: Array<{ path: string; content: string }> = [];
      for (const relPath of selected) {
        const content = await this.readFileCapped(
          join(dir, relPath),
          maxFileBytes,
        );
        if (content !== null) smallFileTexts.push({ path: relPath, content });
      }

      const readmeText = await this.findReadme(dir, maxFileBytes);

      return { filePaths, readmeText, smallFileTexts };
    } catch (error) {
      this.logger.warn(
        `Clone-based scan failed for ${owner}/${name}: ${(error as Error).message}`,
      );
      return null;
    } finally {
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Current HEAD commit SHA + default branch over git's own transport - no
   * GitHub REST call at all (the REST equivalent, getRepositoryHead, is
   * actually *two* REST calls: repo metadata, then the branch ref). Used to
   * make the incremental "did this change" decision for clone-eligible
   * repos without spending any GitHub quota or Redis rate-limit bookkeeping
   * on it. Fails closed - null on any error, letting the caller fall back
   * to the REST-based check exactly as before.
   */
  async getRemoteHead(owner: string, name: string): Promise<RemoteHead | null> {
    if (!(await this.checkGitAvailable())) return null;
    const timeoutMs = Number(
      this.config.get('CLONE_SCAN_TIMEOUT_MS') || 30_000,
    );
    const url = `https://github.com/${owner}/${name}.git`;
    try {
      return await this.runGitLsRemote(url, timeoutMs);
    } catch (error) {
      this.logger.warn(
        `git ls-remote failed for ${owner}/${name}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private runGitLsRemote(
    url: string,
    timeoutMs: number,
  ): Promise<RemoteHead | null> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', ['ls-remote', '--symref', url, 'HEAD']);
      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`git ls-remote timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`git ls-remote exited with code ${code}`));
          return;
        }
        resolve(parseLsRemoteHead(stdout));
      });
    });
  }

  private async checkGitAvailable(): Promise<boolean> {
    if (this.gitAvailable !== null) return this.gitAvailable;
    this.gitAvailable = await new Promise<boolean>((resolve) => {
      try {
        const proc = spawn('git', ['--version']);
        proc.on('error', () => resolve(false));
        proc.on('exit', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
    if (!this.gitAvailable) {
      this.logger.warn(
        'git binary not found - clone-based scanning disabled, falling back to REST file fetch',
      );
    }
    return this.gitAvailable;
  }

  private runGitClone(
    url: string,
    dir: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'git',
        ['clone', '--depth', '1', '--single-branch', '--no-tags', url, dir],
        { stdio: 'ignore' },
      );
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`git clone timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`git clone exited with code ${code}`));
      });
    });
  }

  private async walk(root: string, dir: string, out: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await this.walk(root, join(dir, entry.name), out);
      } else if (entry.isFile()) {
        const rel = join(dir, entry.name)
          .slice(root.length + 1)
          .split('\\')
          .join('/');
        out.push(rel);
      }
    }
  }

  private async readFileCapped(
    absPath: string,
    maxBytes: number,
  ): Promise<string | null> {
    try {
      const st = await stat(absPath);
      if (st.size > maxBytes) return null;
      const buf = await readFile(absPath);
      // Skip likely-binary files (null byte in the first chunk).
      if (buf.subarray(0, 512).includes(0)) return null;
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  private async findReadme(dir: string, maxBytes: number): Promise<string> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const readme = entries.find(
        (e) => e.isFile() && /^readme(\.[a-z0-9]+)?$/i.test(e.name),
      );
      if (!readme) return '';
      return (
        (await this.readFileCapped(join(dir, readme.name), maxBytes)) || ''
      );
    } catch {
      return '';
    }
  }
}
