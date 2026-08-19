import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

import { spawn } from 'child_process';
import {
  buildCloneUrl,
  checkoutPaths,
  cloneShallow,
  getHeadSha,
  isGitAvailable,
  listTree,
  readFileCapped,
  resetGitAvailableCache,
} from './git-repo.util';

function mockSpawnExit(code: number, stdout = '') {
  (spawn as unknown as jest.Mock).mockImplementation(() => {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout?: EventEmitter;
      kill?: () => void;
    };
    emitter.kill = jest.fn();
    emitter.stdout = new EventEmitter();
    process.nextTick(() => {
      if (stdout) emitter.stdout?.emit('data', Buffer.from(stdout));
      emitter.emit('exit', code);
    });
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

function mockSpawnTimeout() {
  (spawn as unknown as jest.Mock).mockImplementation(() => {
    const emitter = new EventEmitter() as EventEmitter & { kill?: () => void };
    emitter.kill = jest.fn();
    // Never emits exit/error - forces the timeout path.
    return emitter;
  });
}

describe('buildCloneUrl', () => {
  it('builds a plain https url with no token', () => {
    expect(buildCloneUrl('acme', 'demo')).toBe(
      'https://github.com/acme/demo.git',
    );
  });

  it('embeds an x-access-token credential when a token is given', () => {
    expect(buildCloneUrl('acme', 'demo', 'ghp_secret')).toBe(
      'https://x-access-token:ghp_secret@github.com/acme/demo.git',
    );
  });
});

describe('isGitAvailable', () => {
  afterEach(() => {
    jest.clearAllMocks();
    resetGitAvailableCache();
  });

  it('resolves true when `git --version` exits 0', async () => {
    mockSpawnExit(0);
    await expect(isGitAvailable()).resolves.toBe(true);
  });

  it('resolves false when git is missing', async () => {
    mockSpawnError();
    await expect(isGitAvailable()).resolves.toBe(false);
  });

  it('caches the result across calls', async () => {
    mockSpawnExit(0);
    await isGitAvailable();
    await isGitAvailable();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('cloneShallow', () => {
  afterEach(() => jest.clearAllMocks());

  it('resolves on exit code 0', async () => {
    mockSpawnExit(0);
    await expect(
      cloneShallow('https://x/y.git', '/tmp/x', 5000),
    ).resolves.toBeUndefined();
  });

  it('rejects on non-zero exit code', async () => {
    mockSpawnExit(128);
    await expect(
      cloneShallow('https://x/y.git', '/tmp/x', 5000),
    ).rejects.toThrow(/exited with code 128/);
  });

  it('rejects when the process errors (e.g. git missing)', async () => {
    mockSpawnError();
    await expect(
      cloneShallow('https://x/y.git', '/tmp/x', 5000),
    ).rejects.toThrow('ENOENT');
  });

  it('rejects with a timeout error and kills the process if it never exits', async () => {
    mockSpawnTimeout();
    await expect(cloneShallow('https://x/y.git', '/tmp/x', 20)).rejects.toThrow(
      /timed out/,
    );
  });
});

describe('listTree', () => {
  afterEach(() => jest.clearAllMocks());

  it('parses NUL-separated paths from ls-tree output', async () => {
    mockSpawnExit(0, 'README.md\0src/index.ts\0package.json\0');
    await expect(listTree('/tmp/x', 5000)).resolves.toEqual([
      'README.md',
      'src/index.ts',
      'package.json',
    ]);
  });

  it('rejects on non-zero exit', async () => {
    mockSpawnExit(1);
    await expect(listTree('/tmp/x', 5000)).rejects.toThrow(
      /exited with code 1/,
    );
  });
});

describe('checkoutPaths', () => {
  afterEach(() => jest.clearAllMocks());

  it('resolves immediately without spawning when given no paths', async () => {
    await expect(checkoutPaths('/tmp/x', [], 5000)).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves on exit code 0', async () => {
    mockSpawnExit(0);
    await expect(
      checkoutPaths('/tmp/x', ['a.txt'], 5000),
    ).resolves.toBeUndefined();
  });

  it('rejects on non-zero exit', async () => {
    mockSpawnExit(1);
    await expect(checkoutPaths('/tmp/x', ['a.txt'], 5000)).rejects.toThrow(
      /exited with code 1/,
    );
  });
});

describe('getHeadSha', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns the trimmed sha from rev-parse output', async () => {
    mockSpawnExit(0, 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4\n');
    await expect(getHeadSha('/tmp/x', 5000)).resolves.toBe(
      'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
    );
  });

  it('rejects on non-zero exit', async () => {
    mockSpawnExit(128);
    await expect(getHeadSha('/tmp/x', 5000)).rejects.toThrow(
      /exited with code 128/,
    );
  });
});

describe('readFileCapped', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp-util-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reads a small text file', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'hello world');
    await expect(readFileCapped(p, 1024)).resolves.toBe('hello world');
  });

  it('returns null when the file exceeds the byte cap', async () => {
    const p = join(dir, 'big.txt');
    await writeFile(p, 'x'.repeat(2000));
    await expect(readFileCapped(p, 1000)).resolves.toBeNull();
  });

  it('returns null for binary content (null byte present)', async () => {
    const p = join(dir, 'bin.dat');
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47]));
    await expect(readFileCapped(p, 1024)).resolves.toBeNull();
  });

  it('returns null (does not throw) for a missing file', async () => {
    await expect(
      readFileCapped(join(dir, 'nope.txt'), 1024),
    ).resolves.toBeNull();
  });
});
