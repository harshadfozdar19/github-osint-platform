import { ConflictException } from '@nestjs/common';
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
  }) {
    const orchestratorQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };
    const searchQueue = { add: jest.fn() };
    const analysisQueue = { add: jest.fn() };
    const detectionQueue = { add: jest.fn() };
    const alertQueue = { add: jest.fn() };

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
    };

    const scanState = {
      findActiveDuplicate: jest
        .fn()
        .mockResolvedValue(overrides.duplicate ?? null),
      getOrThrow: jest.fn(),
      requestCancel: jest.fn(),
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
      scanModel as never,
      brandModel as never,
      scanState as never,
      progress as never,
      { get: () => overrides.adminMaxRepos ?? '25' } as never,
      detectionEngine as never,
    );

    return { service, orchestratorQueue, scanModel, scanState, progress };
  }

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
});
