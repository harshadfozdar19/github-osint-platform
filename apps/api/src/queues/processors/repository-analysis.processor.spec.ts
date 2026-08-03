import { Types } from 'mongoose';
import { RepositoryAnalysisProcessor } from './repository-analysis.processor';
import { RepositoryAnalysisJobData } from '../queue.constants';

describe('RepositoryAnalysisProcessor - HEAD source selection', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();

  function baseRepo(size?: number): RepositoryAnalysisJobData['repo'] {
    return {
      id: 101,
      full_name: 'acme/demo',
      html_url: 'https://github.com/acme/demo',
      description: null,
      stargazers_count: 0,
      forks_count: 0,
      fork: false,
      language: null,
      topics: [],
      created_at: '2024-01-01T00:00:00Z',
      pushed_at: '2024-01-02T00:00:00Z',
      owner: { login: 'acme' },
      name: 'demo',
      size,
    };
  }

  function build(overrides: {
    shouldAttempt: boolean;
    remoteHead: { sha: string; defaultBranch?: string } | null;
  }) {
    const scanQueue = {
      enqueueDetection: jest.fn().mockResolvedValue(undefined),
    };
    const scanState = {
      assertOwned: jest.fn().mockResolvedValue({}),
      isCancelled: jest.fn().mockResolvedValue(false),
      isTerminal: jest.fn().mockResolvedValue(false),
      completeAnalysisUnit: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = {
      upsertRepository: jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    const incremental = {
      isAlreadyCompleted: jest.fn().mockResolvedValue(false),
      findByGithubId: jest.fn().mockResolvedValue(null),
      // Always resolve as "unchanged" so the test stops at the skip branch,
      // isolating exactly the HEAD-source decision under test.
      decideRescan: jest.fn().mockReturnValue({
        analyze: false,
        reason: 'unchanged',
        commitSha: 'git-or-rest-sha',
      }),
      logDecision: jest.fn(),
    };
    const github = {
      getRepositoryHead: jest.fn().mockResolvedValue({
        sha: 'rest-sha',
        defaultBranch: 'main',
      }),
      clearScanPause: jest.fn().mockResolvedValue(undefined),
    };
    const config = { get: () => '120000' };
    const cloneScan = {
      shouldAttempt: jest.fn().mockResolvedValue(overrides.shouldAttempt),
      getRemoteHead: jest.fn().mockResolvedValue(overrides.remoteHead),
    };

    const processor = new RepositoryAnalysisProcessor(
      scanQueue as never,
      scanState as never,
      pipeline as never,
      incremental as never,
      github as never,
      config as never,
      cloneScan as never,
    );

    return { processor, github, cloneScan, incremental, pipeline };
  }

  function makeJob(repo: RepositoryAnalysisJobData['repo']) {
    return {
      data: {
        workspaceId,
        scanJobId,
        mode: 'incremental',
        rulesetVersion: 'ruleset-1',
        repo,
      },
      opts: {},
    } as never;
  }

  it('uses git ls-remote and skips the REST HEAD call when clone-eligible and successful', async () => {
    const { processor, github, cloneScan, incremental } = build({
      shouldAttempt: true,
      remoteHead: { sha: 'git-sha-123', defaultBranch: 'main' },
    });

    await processor.process(makeJob(baseRepo(500)));

    expect(cloneScan.shouldAttempt).toHaveBeenCalledWith(500);
    expect(cloneScan.getRemoteHead).toHaveBeenCalledWith('acme', 'demo');
    expect(github.getRepositoryHead).not.toHaveBeenCalled();
    expect(incremental.decideRescan).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: 'git-sha-123' }),
    );
  });

  it('falls back to the REST HEAD call when clone-eligible but git ls-remote fails', async () => {
    const { processor, github, cloneScan, incremental } = build({
      shouldAttempt: true,
      remoteHead: null,
    });

    await processor.process(makeJob(baseRepo(500)));

    expect(cloneScan.getRemoteHead).toHaveBeenCalledWith('acme', 'demo');
    expect(github.getRepositoryHead).toHaveBeenCalled();
    expect(incremental.decideRescan).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: 'rest-sha' }),
    );
  });

  it('uses the REST HEAD call directly when not clone-eligible', async () => {
    const { processor, github, cloneScan } = build({
      shouldAttempt: false,
      remoteHead: null,
    });

    await processor.process(makeJob(baseRepo(undefined)));

    expect(cloneScan.getRemoteHead).not.toHaveBeenCalled();
    expect(github.getRepositoryHead).toHaveBeenCalled();
  });
});
