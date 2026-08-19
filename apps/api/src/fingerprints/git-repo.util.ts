import { spawn } from 'child_process';
import { readFile, stat } from 'fs/promises';

/**
 * Standalone git primitives for full-tree reference ingestion. Deliberately
 * separate from CloneScanService: that service caps checkout to a
 * priority-ranked top-N files (enough to find secrets/brand mentions),
 * while reference ingestion needs every eligible file in the tree to build
 * a faithful fingerprint of the client's own codebase. Mirrors
 * CloneScanService's proven spawn/timeout/error-handling shape exactly so
 * behavior here is just as predictable.
 */

let gitAvailable: boolean | null = null;

export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  gitAvailable = await new Promise<boolean>((resolve) => {
    try {
      const proc = spawn('git', ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return gitAvailable;
}

/** Test-only: clears the cached git-availability check between test cases. */
export function resetGitAvailableCache(): void {
  gitAvailable = null;
}

/** Embeds a token for private-repo HTTPS auth; returns a plain URL when no token is given. */
export function buildCloneUrl(
  owner: string,
  repo: string,
  token?: string,
): string {
  if (token) {
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

export function cloneShallow(
  url: string,
  dir: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'git',
      [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        '--depth',
        '1',
        '--single-branch',
        '--no-tags',
        url,
        dir,
      ],
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

/** Lists every file in HEAD's tree with zero blob content downloaded. */
export function listTree(dir: string, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', [
      '-C',
      dir,
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      'HEAD',
    ]);
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`git ls-tree timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git ls-tree exited with code ${code}`));
        return;
      }
      const paths = Buffer.concat(chunks)
        .toString('utf8')
        .split('\0')
        .map((p) => p.trim())
        .filter(Boolean);
      resolve(paths);
    });
  });
}

/** Materializes only the given paths (lazily fetches just their blobs). */
export function checkoutPaths(
  dir: string,
  paths: string[],
  timeoutMs: number,
): Promise<void> {
  if (paths.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', dir, 'checkout', 'HEAD', '--', ...paths], {
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`git checkout timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git checkout exited with code ${code}`));
    });
  });
}

/** HEAD commit sha of the cloned tree - recorded on fingerprints so re-ingestion can detect "nothing changed". */
export function getHeadSha(dir: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`git rev-parse timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git rev-parse exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

/** Reads a file if it's within the size cap and not binary (null-byte heuristic); returns null otherwise rather than throwing. */
export async function readFileCapped(
  absPath: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const st = await stat(absPath);
    if (st.size > maxBytes) return null;
    const buf = await readFile(absPath);
    if (buf.subarray(0, 512).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
