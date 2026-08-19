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

    it('is attempted (git-availability permitting) when the repo size is unknown, relying on the clone timeout as the safety net', async () => {
      mockSpawnExit(0);
      const service = new CloneScanService(buildConfig());
      await expect(service.shouldAttempt(undefined)).resolves.toBe(true);
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

    /** Fixture repo tree, as `git ls-tree -z --name-only` would report it. */
    const FIXTURE_PATHS = [
      'README.md',
      '.env',
      'node_modules/somepkg/index.js',
      'src.js',
    ];
    const FIXTURE_CONTENT: Record<string, string> = {
      'README.md': '# Demo repo',
      '.env': 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      'node_modules/somepkg/index.js': 'module.exports = {}',
      'src.js': 'console.log("hi")',
    };

    /**
     * Simulates the two git steps the real flow now runs: clone (a plain
     * shallow clone - materializes every fixture file on disk immediately,
     * no separate checkout step) and ls-tree (reports the fixture paths from
     * what's now actually on disk).
     */
    function mockPartialCloneFlow() {
      (spawn as unknown as jest.Mock).mockImplementation(
        (_cmd: string, args: string[]) => {
          const emitter = new EventEmitter() as EventEmitter & {
            stdout?: EventEmitter;
            kill?: () => void;
          };
          emitter.kill = jest.fn();
          emitter.stdout = new EventEmitter();

          if (args.includes('clone')) {
            const dir = args[args.length - 1];
            dirsToClean.push(dir);
            void (async () => {
              for (const p of FIXTURE_PATHS) {
                const abs = join(dir, p);
                await mkdir(join(abs, '..'), { recursive: true });
                await writeFile(abs, FIXTURE_CONTENT[p] ?? '');
              }
              emitter.emit('exit', 0);
            })();
          } else if (args.includes('ls-tree')) {
            process.nextTick(() => {
              emitter.stdout?.emit(
                'data',
                Buffer.from(FIXTURE_PATHS.join('\0') + '\0'),
              );
              emitter.emit('exit', 0);
            });
          } else {
            process.nextTick(() => emitter.emit('exit', 0));
          }
          return emitter;
        },
      );
    }

    it('selects credential-priority files, excludes vendor dirs, and reads the README', async () => {
      mockPartialCloneFlow();

      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo');

      expect(result).not.toBeNull();
      expect(result?.readmeText).toContain('Demo repo');
      expect(result?.smallFileTexts.some((f) => f.path === '.env')).toBe(true);
      expect(result?.filePaths.some((p) => p.includes('node_modules'))).toBe(
        false,
      );
    });

    it('reports only the priority-selected files in smallFileTexts, not every file on disk', async () => {
      mockPartialCloneFlow();
      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo');

      // node_modules is excluded from selection even though it's present on
      // disk after the full clone - proof the priority filter still governs
      // what gets reported, not just what git happened to materialize.
      expect(
        result?.smallFileTexts.some((f) => f.path.includes('node_modules')),
      ).toBe(false);
      expect(result?.smallFileTexts.some((f) => f.path === '.env')).toBe(true);
      expect(result?.readmePath).toBe('README.md');
    });

    it('returns null (and does not throw) when the clone fails', async () => {
      mockSpawnExit(128);
      const service = new CloneScanService(buildConfig());
      await expect(service.cloneAndScan('acme', 'missing')).resolves.toBeNull();
    });

    it('passes --branch to git clone when a branch is specified, for cloning a non-default side branch', async () => {
      mockPartialCloneFlow();
      const service = new CloneScanService(buildConfig());
      await service.cloneAndScan('acme', 'demo', [], { branch: 'feature/x' });

      const cloneCall = (spawn as unknown as jest.Mock).mock.calls.find(
        ([, args]: [string, string[]]) => args.includes('clone'),
      );
      expect(cloneCall).toBeDefined();
      const args: string[] = cloneCall[1];
      const branchFlagIndex = args.indexOf('--branch');
      expect(branchFlagIndex).toBeGreaterThan(-1);
      expect(args[branchFlagIndex + 1]).toBe('feature/x');
    });

    it('never adds --branch when no branch is given, for the normal default-branch flow', async () => {
      mockPartialCloneFlow();
      const service = new CloneScanService(buildConfig());
      await service.cloneAndScan('acme', 'demo');

      const cloneCall = (spawn as unknown as jest.Mock).mock.calls.find(
        ([, args]: [string, string[]]) => args.includes('clone'),
      );
      expect(cloneCall[1]).not.toContain('--branch');
    });

    it('refuses to clone (fails closed to null, never calls git) when the branch name looks like an injected flag', async () => {
      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo', [], {
        branch: '--upload-pack=evil',
      });
      expect(result).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('finds brand mentions anywhere in the tree via git grep, not just the selected files', async () => {
      (spawn as unknown as jest.Mock).mockImplementation(
        (_cmd: string, args: string[]) => {
          const emitter = new EventEmitter() as EventEmitter & {
            stdout?: EventEmitter;
            kill?: () => void;
          };
          emitter.kill = jest.fn();
          emitter.stdout = new EventEmitter();

          if (args.includes('clone')) {
            const dir = args[args.length - 1];
            dirsToClean.push(dir);
            void (async () => {
              await mkdir(dir, { recursive: true });
              emitter.emit('exit', 0);
            })();
          } else if (args.includes('ls-tree')) {
            process.nextTick(() => {
              emitter.stdout?.emit(
                'data',
                Buffer.from(FIXTURE_PATHS.join('\0') + '\0'),
              );
              emitter.emit('exit', 0);
            });
          } else if (args.includes('grep')) {
            process.nextTick(() => {
              emitter.stdout?.emit(
                'data',
                Buffer.from(
                  'HEAD:src/deep/nested/scraper.py:42:process.acmebrand.login here\n',
                ),
              );
              emitter.emit('exit', 0);
            });
          } else {
            process.nextTick(() => emitter.emit('exit', 0));
          }
          return emitter;
        },
      );

      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo', ['acmebrand']);

      expect(result?.brandMatches).toEqual([
        {
          alias: 'acmebrand',
          path: 'src/deep/nested/scraper.py',
          lineNumber: 42,
          line: 'process.acmebrand.login here',
        },
      ]);
    });

    it('rejects a git-grep hit where the alias is only buried mid-word in an unrelated identifier ("fyers" inside "identifyers")', async () => {
      (spawn as unknown as jest.Mock).mockImplementation(
        (_cmd: string, args: string[]) => {
          const emitter = new EventEmitter() as EventEmitter & {
            stdout?: EventEmitter;
            kill?: () => void;
          };
          emitter.kill = jest.fn();
          emitter.stdout = new EventEmitter();

          if (args.includes('clone')) {
            const dir = args[args.length - 1];
            dirsToClean.push(dir);
            void (async () => {
              await mkdir(dir, { recursive: true });
              emitter.emit('exit', 0);
            })();
          } else if (args.includes('ls-tree')) {
            process.nextTick(() => {
              emitter.stdout?.emit(
                'data',
                Buffer.from(FIXTURE_PATHS.join('\0') + '\0'),
              );
              emitter.emit('exit', 0);
            });
          } else if (args.includes('grep')) {
            process.nextTick(() => {
              // git grep -F is a plain fixed-string search - it has no
              // concept of word boundaries, so it genuinely reports this
              // line as a hit for the literal substring "fyers".
              emitter.stdout?.emit(
                'data',
                Buffer.from(
                  'HEAD:docs/glossary.py:5:a list of identifyers here\n',
                ),
              );
              emitter.emit('exit', 0);
            });
          } else {
            process.nextTick(() => emitter.emit('exit', 0));
          }
          return emitter;
        },
      );

      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo', ['fyers']);

      expect(result?.brandMatches).toEqual([]);
    });

    it('skips the alias/keyword grep passes when none are given, but still runs the secret-anchor pass', async () => {
      mockPartialCloneFlow();
      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo');
      expect(result?.brandMatches).toEqual([]);
      expect(result?.keywordMatches).toEqual([]);
      // Secret-anchor grep is unconditional - it doesn't depend on any brand
      // being configured at all, so exactly one grep call still happens.
      const grepCalls = (spawn as unknown as jest.Mock).mock.calls.filter((c) =>
        (c[1] as string[]).includes('grep'),
      );
      expect(grepCalls).toHaveLength(1);
    });

    /** Builds a full mock flow, letting the caller supply grep stdout keyed by whichever `-e` patterns that grep call was given. */
    function mockCloneFlowWithGrepRouter(
      grepStdoutFor: (patterns: string[]) => string,
    ) {
      (spawn as unknown as jest.Mock).mockImplementation(
        (_cmd: string, args: string[]) => {
          const emitter = new EventEmitter() as EventEmitter & {
            stdout?: EventEmitter;
            kill?: () => void;
          };
          emitter.kill = jest.fn();
          emitter.stdout = new EventEmitter();

          if (args.includes('clone')) {
            const dir = args[args.length - 1];
            dirsToClean.push(dir);
            void (async () => {
              for (const p of FIXTURE_PATHS) {
                const abs = join(dir, p);
                await mkdir(join(abs, '..'), { recursive: true });
                await writeFile(abs, FIXTURE_CONTENT[p] ?? '');
              }
              emitter.emit('exit', 0);
            })();
          } else if (args.includes('ls-tree')) {
            process.nextTick(() => {
              emitter.stdout?.emit(
                'data',
                Buffer.from(FIXTURE_PATHS.join('\0') + '\0'),
              );
              emitter.emit('exit', 0);
            });
          } else if (args.includes('grep')) {
            const patterns = args
              .filter((_, i) => args[i - 1] === '-e')
              .filter(Boolean);
            const stdout = grepStdoutFor(patterns);
            process.nextTick(() => {
              if (stdout) emitter.stdout?.emit('data', Buffer.from(stdout));
              emitter.emit('exit', stdout ? 0 : 1);
            });
          } else {
            process.nextTick(() => emitter.emit('exit', 0));
          }
          return emitter;
        },
      );
    }

    it('attributes a combined keyword grep hit back to the specific keyword(s) it actually matched', async () => {
      mockCloneFlowWithGrepRouter((patterns) => {
        // Only the keyword-grep call includes these two terms together.
        if (patterns.includes('otp') && patterns.includes('kyc fraud')) {
          return 'HEAD:config/app.py:10:handle_otp_bypass_flow()\n';
        }
        return '';
      });
      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo', [], {
        customKeywords: ['otp', 'kyc fraud'],
      });
      expect(result?.keywordMatches).toEqual([
        {
          alias: 'otp',
          path: 'config/app.py',
          lineNumber: 10,
          line: 'handle_otp_bypass_flow()',
        },
      ]);
    });

    it('rejects a combined keyword grep hit for a keyword only buried mid-word in an unrelated identifier', async () => {
      mockCloneFlowWithGrepRouter((patterns) => {
        if (patterns.includes('fyers')) {
          // Genuinely matched by git grep -F (fixed-string), but "fyers" is
          // not a real word/identifier component here.
          return 'HEAD:docs/glossary.py:5:a list of identifyers here\n';
        }
        return '';
      });
      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo', [], {
        customKeywords: ['fyers'],
      });
      expect(result?.keywordMatches).toEqual([]);
    });

    it('returns raw secret-anchor candidates without treating a mere anchor hit as a confirmed secret', async () => {
      mockCloneFlowWithGrepRouter((patterns) => {
        // The secret-anchor call includes AKIA among its patterns.
        if (patterns.includes('AKIA')) {
          return 'HEAD:config/notes.md:3:mentions AKIA prefix in passing\n';
        }
        return '';
      });
      const service = new CloneScanService(buildConfig());
      const result = await service.cloneAndScan('acme', 'demo');
      expect(result?.secretCandidates).toEqual([
        {
          path: 'config/notes.md',
          lineNumber: 3,
          line: 'mentions AKIA prefix in passing',
        },
      ]);
    });

    it('respects ENABLE_DEEP_KEYWORD_GREP=false and ENABLE_DEEP_SECRET_GREP=false', async () => {
      mockPartialCloneFlow();
      const service = new CloneScanService(
        buildConfig({
          ENABLE_DEEP_KEYWORD_GREP: 'false',
          ENABLE_DEEP_SECRET_GREP: 'false',
        }),
      );
      const result = await service.cloneAndScan('acme', 'demo', [], {
        customKeywords: ['otp'],
      });
      expect(result?.keywordMatches).toEqual([]);
      expect(result?.secretCandidates).toEqual([]);
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
