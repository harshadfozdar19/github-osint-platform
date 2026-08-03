import { EventEmitter } from 'events';
import { join } from 'path';
import { mkdir, rm, writeFile } from 'fs/promises';
import { ConfigService } from '@nestjs/config';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

import { spawn } from 'child_process';
import { CloneScanService, parseLsRemoteHead } from './clone-scan.service';

function buildConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    ENABLE_CLONE_SCAN: 'true',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function mockSpawnExit(code: number) {
  (spawn as unknown as jest.Mock).mockImplementation(() => {
    const emitter = new EventEmitter() as EventEmitter & { kill?: () => void };
    emitter.kill = jest.fn();
    process.nextTick(() => emitter.emit('exit', code));
    return emitter;
  });
}

function mockSpawnError() {
  (spawn as unknown as jest.Mock).mockImplementation(() => {
    const emitter = new EventEmitter() as EventEmitter & { kill?: () => void };
    emitter.kill = jest.fn();
    process.nextTick(() => emitter.emit('error', new Error('ENOENT')));
    return emitter;
  });
}

/** Mocks `git --version` (first call) succeeding, then `git ls-remote` (second call) with given stdout/exit code. */
function mockSpawnLsRemote(stdout: string, exitCode = 0) {
  let call = 0;
  (spawn as unknown as jest.Mock).mockImplementation(() => {
    call += 1;
    const emitter = new EventEmitter() as EventEmitter & {
      stdout?: EventEmitter;
      kill?: () => void;
    };
    emitter.kill = jest.fn();
    emitter.stdout = new EventEmitter();
    if (call === 1) {
      // git --version (availability check)
      process.nextTick(() => emitter.emit('exit', 0));
    } else {
      process.nextTick(() => {
        emitter.stdout?.emit('data', Buffer.from(stdout));
        emitter.emit('exit', exitCode);
      });
    }
    return emitter;
  });
}

describe('CloneScanService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isEnabled', () => {
    it('reflects the ENABLE_CLONE_SCAN flag', () => {
      expect(new CloneScanService(buildConfig()).isEnabled()).toBe(true);
      expect(
        new CloneScanService(
          buildConfig({ ENABLE_CLONE_SCAN: 'false' }),
        ).isEnabled(),
      ).toBe(false);
    });
  });

  describe('shouldAttempt', () => {
    it('is false when the feature flag is off', async () => {
      const service = new CloneScanService(
        buildConfig({ ENABLE_CLONE_SCAN: 'false' }),
      );
      await expect(service.shouldAttempt(100)).resolves.toBe(false);
    });

    it('is false when the repo size is unknown - conservative default', async () => {
      const service = new CloneScanService(buildConfig());
      await expect(service.shouldAttempt(undefined)).resolves.toBe(false);
    });

    it('is false when the repo exceeds the configured size cap', async () => {
      const service = new CloneScanService(
        buildConfig({ CLONE_SCAN_MAX_REPO_SIZE_KB: '1000' }),
      );
      await expect(service.shouldAttempt(5000)).resolves.toBe(false);
    });

    it('is true when within the size cap and git is available', async () => {
      mockSpawnExit(0);
      const service = new CloneScanService(
        buildConfig({ CLONE_SCAN_MAX_REPO_SIZE_KB: '10000' }),
      );
      await expect(service.shouldAttempt(500)).resolves.toBe(true);
    });

    it('is false when the git binary is not available', async () => {
      mockSpawnError();
      const service = new CloneScanService(buildConfig());
      await expect(service.shouldAttempt(500)).resolves.toBe(false);
    });

    it('caches the git-availability check across calls', async () => {
      mockSpawnExit(0);
      const service = new CloneScanService(buildConfig());
      await service.shouldAttempt(100);
      await service.shouldAttempt(100);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('cloneAndScan', () => {
    const dirsToClean: string[] = [];

    afterAll(async () => {
      await Promise.all(
        dirsToClean.map((d) =>
          rm(d, { recursive: true, force: true }).catch(() => undefined),
        ),
      );
    });

    it('selects credential-priority files, excludes vendor dirs, and reads the README', async () => {
      // Simulate a successful clone by writing fixture files into whatever
      // temp dir mkdtemp creates, instead of actually invoking git/network.
      (spawn as unknown as jest.Mock).mockImplementation(
        (_cmd: string, args: string[]) => {
          const dir = args[args.length - 1];
          dirsToClean.push(dir);
          const emitter = new EventEmitter() as EventEmitter & {
            kill?: () => void;
          };
          emitter.kill = jest.fn();
          void (async () => {
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'README.md'), '# Demo repo');
            await writeFile(
              join(dir, '.env'),
              'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
            );
            await mkdir(join(dir, 'node_modules', 'somepkg'), {
              recursive: true,
            });
            await writeFile(
              join(dir, 'node_modules', 'somepkg', 'index.js'),
              'module.exports = {}',
            );
            await writeFile(join(dir, 'src.js'), 'console.log("hi")');
            emitter.emit('exit', 0);
          })();
          return emitter;
        },
      );

      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo');

      expect(result).not.toBeNull();
      expect(result?.readmeText).toContain('Demo repo');
      expect(result?.smallFileTexts.some((f) => f.path === '.env')).toBe(true);
      expect(result?.filePaths.some((p) => p.includes('node_modules'))).toBe(
        false,
      );
    });

    it('returns null (and does not throw) when the clone fails', async () => {
      mockSpawnExit(128);
      const service = new CloneScanService(buildConfig());
      await expect(service.cloneAndScan('acme', 'missing')).resolves.toBeNull();
    });
  });

  describe('getRemoteHead', () => {
    it('returns the commit sha and default branch from git ls-remote', async () => {
      mockSpawnLsRemote(
        'ref: refs/heads/main\tHEAD\na1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4\tHEAD\n',
      );
      const service = new CloneScanService(buildConfig());
      await expect(service.getRemoteHead('acme', 'demo')).resolves.toEqual({
        sha: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
        defaultBranch: 'main',
      });
    });

    it('returns null when git is unavailable', async () => {
      mockSpawnError();
      const service = new CloneScanService(buildConfig());
      await expect(service.getRemoteHead('acme', 'demo')).resolves.toBeNull();
    });

    it('returns null (does not throw) when ls-remote exits non-zero', async () => {
      mockSpawnLsRemote('', 128);
      const service = new CloneScanService(buildConfig());
      await expect(
        service.getRemoteHead('acme', 'missing'),
      ).resolves.toBeNull();
    });
  });
});

describe('parseLsRemoteHead', () => {
  it('parses a normal --symref response', () => {
    expect(
      parseLsRemoteHead(
        'ref: refs/heads/main\tHEAD\na1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4\tHEAD\n',
      ),
    ).toEqual({
      sha: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
      defaultBranch: 'main',
    });
  });

  it('parses a default branch other than main', () => {
    expect(
      parseLsRemoteHead(
        'ref: refs/heads/master\tHEAD\nb2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1\tHEAD\n',
      )?.defaultBranch,
    ).toBe('master');
  });

  it('returns null when there is no HEAD sha line', () => {
    expect(parseLsRemoteHead('')).toBeNull();
  });

  it('returns a sha with no default branch if the symref line is missing', () => {
    expect(
      parseLsRemoteHead('a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4\tHEAD\n'),
    ).toEqual({ sha: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4' });
  });
});
