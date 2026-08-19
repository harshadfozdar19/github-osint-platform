import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ScanJobStatus } from '../common/enums';
import { ScanQueueService } from './scan-queue.service';

describe('ScanQueueService', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();

  function buildService(overrides: {
    duplicate?: Record<string, unknown> | null;
    createResult?: Record<string, unknown>;
    adminMaxRepos?: string;
    brandFindOneResult?: Record<string, unknown> | null;
  }) {
    const orchestratorQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const searchQueue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const analysisQueue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const detectionQueue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const alertQueue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const branchAnalysisQueue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };

    const createdId = new Types.ObjectId();
    const scanModel = {
      create: jest.fn().mockResolvedValue({
        _id: createdId,
        workspaceId: new Types.ObjectId(workspaceId),
        status: ScanJobStatus.QUEUED,
        toObject() {
          return {
            _id: createdId,
            workspaceId,
            status: ScanJobStatus.QUEUED,
            message: 'Scan queued',
          };
        },
        ...overrides.createResult,
      }),
    };

    const brandModel = {
      find: jest.fn().mockReturnValue({
        select: () => ({
          lean: () => ({
            exec: () => Promise.resolve([{ _id: new Types.ObjectId() }]),
          }),
        }),
      }),
      findOne: jest.fn().mockReturnValue({
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve(
                overrides.brandFindOneResult === undefined
                  ? { _id: new Types.ObjectId(), trustedGithubOwners: [] }
                  : overrides.brandFindOneResult,
              ),
          }),
        }),
      }),
    };

    const scanState = {
      findActiveDuplicate: jest
        .fn()
        .mockResolvedValue(overrides.duplicate ?? null),
      getOrThrow: jest.fn(),
      requestCancel: jest.fn().mockResolvedValue({ toObject: () => ({}) }),
      finalize: jest.fn().mockResolvedValue({ toObject: () => ({}) }),
      markRunning: jest.fn().mockResolvedValue(null),
    };

    const progress = {
      emit: jest.fn().mockResolvedValue(null),
    };

    const detectionEngine = {
      getRulesetVersion: jest.fn().mockReturnValue('test-ruleset'),
    };

    const service = new ScanQueueService(
      orchestratorQueue as never,
      searchQueue as never,
      analysisQueue as never,
      detectionQueue as never,
      alertQueue as never,
      branchAnalysisQueue as never,
      scanModel as never,
      brandModel as never,
      scanState as never,
      progress as never,
      { get: () => overrides.adminMaxRepos ?? '25' } as never,
      detectionEngine as never,
    );

    return {
      service,
      orchestratorQueue,
      searchQueue,
      analysisQueue,
      detectionQueue,
      alertQueue,
      branchAnalysisQueue,
      scanModel,
      scanState,
      progress,
    };
  }

  it("enqueueGithubSearch gives code-search jobs one lower priority tier than repo-search jobs (regression: code search's much tighter 10/min GitHub ceiling meant a ready repo-search job could sit behind an already-exhausted code-search job in the queue with no reason to)", async () => {
    const { service, searchQueue } = buildService({});
    const base = {
      workspaceId,
      scanJobId: 'scan-1',
      query: 'zerodha',
      queryIndex: 0,
      maxRepos: 100,
    };

    await service.enqueueGithubSearch(
      { ...base, searchKind: 'repositories' },
      5,
    );
    await service.enqueueGithubSearch({ ...base, searchKind: 'code' }, 5);

    const repoCall = searchQueue.add.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as { searchKind?: string }).searchKind === 'repositories',
    );
    const codeCall = searchQueue.add.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as { searchKind?: string }).searchKind === 'code',
    );
    expect((repoCall![2] as { priority: number }).priority).toBe(5);
    expect((codeCall![2] as { priority: number }).priority).toBe(6);
  });

  it('leaves priority untouched when no searchKind is given (defaults to repositories)', async () => {
    const { service, searchQueue } = buildService({});
    await service.enqueueGithubSearch(
      {
        workspaceId,
        scanJobId: 'scan-1',
        query: 'zerodha',
        queryIndex: 0,
        maxRepos: 100,
      },
      3,
    );
    const [, , opts] = searchQueue.add.mock.calls[0] as [
      string,
      unknown,
      { priority: number },
    ];
    expect(opts.priority).toBe(3);
  });

  it('enqueues a manual scan and persists queued status', async () => {
    const { service, orchestratorQueue, scanModel } = buildService({});
    const result = await service.enqueueManualScan(workspaceId, userId);

    expect(scanModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ScanJobStatus.QUEUED,
        type: 'manual',
        mode: 'incremental',
      }),
    );
    expect(orchestratorQueue.add).toHaveBeenCalledWith(
      'orchestrate',
      expect.objectContaining({ workspaceId }),
      expect.objectContaining({
        jobId: expect.stringContaining('orchestrator') as string,
        attempts: expect.any(Number) as number,
        backoff: expect.objectContaining({
          type: 'exponential',
        }) as { type: string },
      }),
    );
    expect(result.status).toBe(ScanJobStatus.QUEUED);
  });

  it('rejects duplicate active scans for same workspace+config', async () => {
    const existingId = new Types.ObjectId().toHexString();
    const { service } = buildService({
      duplicate: { _id: existingId, status: ScanJobStatus.RUNNING },
    });

    await expect(
      service.enqueueManualScan(workspaceId, userId),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('includes workspaceId on every orchestrator job payload', async () => {
    const { service, orchestratorQueue } = buildService({});
    await service.enqueueManualScan(workspaceId, userId);
    const [, payload] = orchestratorQueue.add.mock.calls[0] as [
      string,
      { workspaceId: string; scanJobId: string },
    ];
    expect(payload.workspaceId).toBe(workspaceId);
    expect(payload.scanJobId).toBeTruthy();
  });

  it('passes mode and forceFullScan into orchestrator payload', async () => {
    const { service, orchestratorQueue, scanModel } = buildService({});
    await service.enqueueManualScan(workspaceId, userId, {
      mode: 'full' as never,
      forceFullScan: true,
    });
    expect(scanModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'full',
        forceFullScan: true,
      }),
    );
    const [, payload] = orchestratorQueue.add.mock.calls[0] as [
      string,
      { mode: string; forceFullScan: boolean },
    ];
    expect(payload.mode).toBe('full');
    expect(payload.forceFullScan).toBe(true);
  });

  it('uses the admin ceiling when no per-scan maxRepos is requested', async () => {
    const { service, scanModel } = buildService({ adminMaxRepos: '500' });
    await service.enqueueManualScan(workspaceId, userId);
    expect(scanModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ maxRepos: 500 }),
    );
  });

  it('honors a lower per-scan maxRepos request', async () => {
    const { service, scanModel } = buildService({ adminMaxRepos: '500' });
    await service.enqueueManualScan(workspaceId, userId, { maxRepos: 50 });
    expect(scanModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ maxRepos: 50 }),
    );
  });

  it('clamps a per-scan maxRepos request above the admin ceiling', async () => {
    const { service, scanModel } = buildService({ adminMaxRepos: '500' });
    await service.enqueueManualScan(workspaceId, userId, { maxRepos: 999999 });
    expect(scanModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ maxRepos: 500 }),
    );
  });

  it('persists a created-date range onto the scan job', async () => {
    const { service, scanModel } = buildService({});
    await service.enqueueManualScan(workspaceId, userId, {
      createdFrom: '2026-07-31',
      createdTo: '2026-08-02',
    });
    expect(scanModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        createdFrom: new Date('2026-07-31'),
        createdTo: new Date('2026-08-02'),
      }),
    );
  });

  it('persists continueDiscovery on the scan job when requested, and defaults it false otherwise', async () => {
    const { service, scanModel } = buildService({});
    await service.enqueueManualScan(workspaceId, userId, {
      continueDiscovery: true,
    });
    expect(scanModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ continueDiscovery: true }),
    );

    await service.enqueueManualScan(workspaceId, userId, {});
    expect(scanModel.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ continueDiscovery: false }),
    );
  });

  it('rejects createdFrom after createdTo', async () => {
    const { service } = buildService({});
    await expect(
      service.enqueueManualScan(workspaceId, userId, {
        createdFrom: '2026-08-02',
        createdTo: '2026-07-31',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a date range combined with a code-search custom query', async () => {
    const { service } = buildService({});
    await expect(
      service.enqueueManualScan(workspaceId, userId, {
        customQuery: 'zerodha filename:.env',
        searchKind: 'code',
        createdFrom: '2026-07-31',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('internalAudit', () => {
    it('rejects internalAudit without brandId', async () => {
      const { service } = buildService({});
      await expect(
        service.enqueueManualScan(workspaceId, userId, {
          internalAudit: true,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects internalAudit combined with customQuery', async () => {
      const { service } = buildService({});
      await expect(
        service.enqueueManualScan(workspaceId, userId, {
          internalAudit: true,
          customQuery: 'org:acme-corp',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects internalAudit when the brand has no trustedGithubOwners configured', async () => {
      const brandId = new Types.ObjectId().toHexString();
      const { service } = buildService({
        brandFindOneResult: {
          _id: new Types.ObjectId(brandId),
          trustedGithubOwners: [],
        },
      });
      await expect(
        service.enqueueManualScan(workspaceId, userId, {
          internalAudit: true,
          brandId,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts internalAudit and persists it on the scan job when the brand has trustedGithubOwners', async () => {
      const brandId = new Types.ObjectId().toHexString();
      const { service, scanModel } = buildService({
        brandFindOneResult: {
          _id: new Types.ObjectId(brandId),
          trustedGithubOwners: ['acme-corp'],
        },
      });
      await service.enqueueManualScan(workspaceId, userId, {
        internalAudit: true,
        brandId,
      });
      expect(scanModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ internalAudit: true }),
      );
    });
  });

  describe('keyword (per-keyword discovery toggle)', () => {
    it('rejects keyword without brandId', async () => {
      const { service } = buildService({});
      await expect(
        service.enqueueManualScan(workspaceId, userId, {
          keyword: 'otp bypass',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects keyword combined with customQuery', async () => {
      const brandId = new Types.ObjectId().toHexString();
      const { service } = buildService({});
      await expect(
        service.enqueueManualScan(workspaceId, userId, {
          keyword: 'otp bypass',
          brandId,
          customQuery: 'org:acme-corp',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects keyword combined with internalAudit', async () => {
      const brandId = new Types.ObjectId().toHexString();
      const { service } = buildService({
        brandFindOneResult: {
          _id: new Types.ObjectId(brandId),
          trustedGithubOwners: ['acme-corp'],
        },
      });
      await expect(
        service.enqueueManualScan(workspaceId, userId, {
          keyword: 'otp bypass',
          brandId,
          internalAudit: true,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a keyword scoped to a brand and persists scopeKeyword on the scan job', async () => {
      const brandId = new Types.ObjectId().toHexString();
      const { service, scanModel } = buildService({
        brandFindOneResult: {
          _id: new Types.ObjectId(brandId),
          trustedGithubOwners: [],
        },
      });
      await service.enqueueManualScan(workspaceId, userId, {
        brandId,
        keyword: 'otp bypass',
        discoveryOnly: true,
      });
      expect(scanModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeKeyword: 'otp bypass',
          discoveryOnly: true,
        }),
      );
    });

    it('rejects searchScope without keyword', async () => {
      const { service } = buildService({});
      await expect(
        service.enqueueManualScan(workspaceId, userId, {
          searchScope: 'code',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("persists searchScope on the scan job when set alongside keyword, and omits it (undefined) when it's the 'both' default or unset", async () => {
      const brandId = new Types.ObjectId().toHexString();
      const { service, scanModel } = buildService({
        brandFindOneResult: {
          _id: new Types.ObjectId(brandId),
          trustedGithubOwners: [],
        },
      });
      await service.enqueueManualScan(workspaceId, userId, {
        brandId,
        keyword: 'otp bypass',
        searchScope: 'code',
      });
      expect(scanModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ searchScope: 'code' }),
      );

      await service.enqueueManualScan(workspaceId, userId, {
        brandId,
        keyword: 'kite login',
      });
      expect(scanModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ searchScope: undefined }),
      );
    });

    it("gives each keyword its own configHash scope so two keyword-scoped scans for the SAME brand don't collide as duplicates", async () => {
      const brandId = new Types.ObjectId().toHexString();
      const { service, scanModel } = buildService({
        brandFindOneResult: {
          _id: new Types.ObjectId(brandId),
          trustedGithubOwners: [],
        },
      });
      await service.enqueueManualScan(workspaceId, userId, {
        brandId,
        keyword: 'otp bypass',
      });
      const firstHash = (scanModel.create as jest.Mock).mock.calls[0][0]
        .configHash as string;

      await service.enqueueManualScan(workspaceId, userId, {
        brandId,
        keyword: 'kite login',
      });
      const secondHash = (scanModel.create as jest.Mock).mock.calls[1][0]
        .configHash as string;

      expect(firstHash).not.toBe(secondHash);
    });
  });

  describe('cancelScan', () => {
    it("resolves without waiting on the best-effort queue sweep (regression: a large waiting/delayed backlog used to stall every cancellation - including the sequential scheduler's own keyword handoff - proportional to total queue depth)", async () => {
      const { service, scanState, searchQueue } = buildService({});
      // A getJobs call that never resolves within this test - if
      // cancelScan awaited the sweep, this test would time out.
      searchQueue.getJobs = jest.fn().mockReturnValue(new Promise(() => {}));

      const scanJobId = new Types.ObjectId().toHexString();
      const result = await service.cancelScan(workspaceId, scanJobId);

      expect(result).toEqual({});
      expect(scanState.requestCancel).toHaveBeenCalledWith(
        workspaceId,
        scanJobId,
      );
      expect(scanState.finalize).toHaveBeenCalledWith(scanJobId);
      // The sweep was still kicked off in the background, just not awaited.
      expect(searchQueue.getJobs).toHaveBeenCalledWith(['waiting', 'delayed']);
    });

    it('removes matching waiting/delayed jobs across every scan queue once the sweep actually runs', async () => {
      const { service, searchQueue } = buildService({});
      const scanJobId = new Types.ObjectId().toHexString();
      const matching = {
        id: `scan-${scanJobId}-search-repositories-0-p1`,
        remove: jest.fn().mockResolvedValue(undefined),
      };
      const unrelated = {
        id: 'scan-someOtherScan-search-repositories-0-p1',
        remove: jest.fn().mockResolvedValue(undefined),
      };
      searchQueue.getJobs = jest.fn().mockResolvedValue([matching, unrelated]);

      await service.cancelScan(workspaceId, scanJobId);
      // The sweep runs asynchronously (fire-and-forget) - flush pending
      // microtasks so it has a chance to complete before asserting.
      await new Promise((resolve) => setImmediate(resolve));

      expect(matching.remove).toHaveBeenCalled();
      expect(unrelated.remove).not.toHaveBeenCalled();
    });
  });

  describe('startBranchAnalysis', () => {
    it('creates a single-unit ScanJob scoped to the repo+branch, marks it running immediately (no orchestrator/discovery phase to wait for), and enqueues exactly one branch-analysis job', async () => {
      const { service, scanModel, scanState, branchAnalysisQueue } =
        buildService({});
      const repositoryDbId = new Types.ObjectId().toHexString();
      const brands = [
        { id: new Types.ObjectId().toHexString(), name: 'Acme', aliases: [] },
      ];

      const job = await service.startBranchAnalysis(
        workspaceId,
        userId,
        { repositoryDbId, githubId: 42, fullName: 'acme/demo' },
        brands,
        'feature/x',
      );

      const createCall = scanModel.create.mock.calls[0][0];
      expect(createCall.mode).toBe('branch_analysis');
      expect(createCall.scopeBranch).toBe('feature/x');
      expect(String(createCall.scopeRepositoryId)).toBe(repositoryDbId);
      expect(createCall.reposTotal).toBe(1);
      expect(createCall.awaitingAnalysis).toBe(1);

      const scanJobId = job._id;
      expect(scanState.markRunning).toHaveBeenCalledWith(String(scanJobId));

      expect(branchAnalysisQueue.add).toHaveBeenCalledTimes(1);
      const [, data] = branchAnalysisQueue.add.mock.calls[0];
      expect(data).toEqual({
        workspaceId,
        scanJobId: String(scanJobId),
        repositoryDbId,
        githubId: 42,
        fullName: 'acme/demo',
        branch: 'feature/x',
        brands,
      });
    });
  });
});
