import { Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { ScanJobStatus } from '../../common/enums';
import {
  ScanProgressService,
  filterEventsAfterSeq,
} from './scan-progress.service';
import {
  ScanProgressEvent,
  ScanProgressEventType,
  ScanProgressPhase,
  computeProgressPercent,
  emptyCounts,
} from './scan-progress.types';

const publishMock = jest.fn().mockResolvedValue(1);
const subscribeMock = jest.fn().mockResolvedValue(1);
const unsubscribeMock = jest.fn().mockResolvedValue(1);
const quitMock = jest.fn().mockResolvedValue('OK');
const onMock = jest.fn();

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    on: onMock,
    publish: publishMock,
    subscribe: subscribeMock,
    unsubscribe: unsubscribeMock,
    quit: quitMock,
  })),
);

describe('computeProgressPercent', () => {
  it('returns 100 for completed scans', () => {
    expect(
      computeProgressPercent({
        status: ScanJobStatus.COMPLETED,
        phase: ScanProgressPhase.COMPLETED,
        counts: emptyCounts(),
      }),
    ).toBe(100);
  });

  it('grows during analysis based on processed/total', () => {
    const percent = computeProgressPercent({
      status: ScanJobStatus.RUNNING,
      phase: ScanProgressPhase.ANALYZING,
      counts: {
        ...emptyCounts(),
        reposDiscovered: 10,
        reposTotal: 10,
        reposProcessed: 5,
      },
    });
    expect(percent).toBeGreaterThanOrEqual(35);
    expect(percent).toBeLessThan(100);
  });
});

describe('filterEventsAfterSeq (reconnect / ordering)', () => {
  it('drops duplicates and out-of-order lower seq values', () => {
    const workspaceId = new Types.ObjectId().toHexString();
    const scanJobId = new Types.ObjectId().toHexString();
    const base = {
      workspaceId,
      scanJobId,
      phase: ScanProgressPhase.ANALYZING,
      status: ScanJobStatus.RUNNING,
      percent: 40,
      message: 'ok',
      timestamp: new Date().toISOString(),
      counts: emptyCounts(),
      terminal: false,
    };
    const events: ScanProgressEvent[] = [
      { ...base, seq: 3, type: ScanProgressEventType.REPOSITORIES_PROCESSED },
      { ...base, seq: 1, type: ScanProgressEventType.STARTED },
      { ...base, seq: 2, type: ScanProgressEventType.SEARCH_PROGRESS },
      { ...base, seq: 2, type: ScanProgressEventType.SEARCH_PROGRESS },
      {
        ...base,
        seq: 4,
        type: ScanProgressEventType.COMPLETED,
        terminal: true,
      },
    ];
    const filtered = filterEventsAfterSeq(events, 1);
    expect(filtered.map((e) => e.seq)).toEqual([2, 3, 4]);
  });
});

describe('ScanProgressService', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const scanJobId = new Types.ObjectId().toHexString();
  let seq = 0;

  function buildService() {
    seq = 0;
    const scanModel = {
      findOneAndUpdate: jest.fn().mockImplementation(() => ({
        lean: () => ({
          exec: () => {
            seq += 1;
            return Promise.resolve({
              _id: scanJobId,
              workspaceId,
              progressSeq: seq,
              progressPercent: 10,
              progressUpdatedAt: new Date(),
              status: ScanJobStatus.RUNNING,
            });
          },
        }),
      })),
      findOne: jest.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              _id: scanJobId,
              workspaceId,
              status: ScanJobStatus.RUNNING,
              progressSeq: 5,
              progressPhase: ScanProgressPhase.ANALYZING,
              progressPercent: 50,
              progressEventType: ScanProgressEventType.REPOSITORIES_PROCESSED,
              progressMessage: 'Repository processed',
              progressUpdatedAt: new Date(),
              progressTerminal: false,
              progressCounts: emptyCounts(),
              message: 'Repository processed',
            }),
        }),
      }),
      findById: jest.fn(),
    };

    const config = {
      get: (key: string) => {
        if (key === 'SCAN_PROGRESS_THROTTLE_MS') return '50';
        return undefined;
      },
    } as unknown as ConfigService;

    const service = new ScanProgressService(scanModel as never, config);
    return { service, scanModel };
  }

  afterEach(() => {
    publishMock.mockClear();
  });

  it('persists seq and publishes over Redis', async () => {
    const { service, scanModel } = buildService();
    const event = await service.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.STARTED,
      phase: ScanProgressPhase.ORCHESTRATING,
      status: ScanJobStatus.RUNNING,
      message: 'Scan started',
      force: true,
    });
    expect(event?.seq).toBe(1);
    expect(scanModel.findOneAndUpdate).toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('throttles non-terminal bursts then flushes latest', async () => {
    const { service } = buildService();
    await service.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.REPOSITORIES_PROCESSED,
      phase: ScanProgressPhase.ANALYZING,
      status: ScanJobStatus.RUNNING,
      message: 'a',
      force: true,
    });
    const second = await service.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.REPOSITORIES_PROCESSED,
      phase: ScanProgressPhase.ANALYZING,
      status: ScanJobStatus.RUNNING,
      message: 'b',
    });
    expect(second).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    await service.onModuleDestroy();
  });

  it('always emits terminal completion/failure/cancel immediately', async () => {
    const { service } = buildService();
    await service.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.REPOSITORIES_PROCESSED,
      phase: ScanProgressPhase.ANALYZING,
      status: ScanJobStatus.RUNNING,
      message: 'a',
      force: true,
    });
    const failed = await service.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.FAILED,
      phase: ScanProgressPhase.FAILED,
      status: ScanJobStatus.FAILED,
      message: 'Scan failed',
      terminal: true,
    });
    expect(failed?.type).toBe(ScanProgressEventType.FAILED);
    expect(failed?.terminal).toBe(true);
    await service.onModuleDestroy();
  });

  it('rejects cross-workspace progress reads (tenant isolation)', async () => {
    const { service, scanModel } = buildService();
    scanModel.findOne = jest.fn().mockReturnValue({
      lean: () => ({
        exec: () => Promise.resolve(null),
      }),
    });
    await expect(
      service.getLatest(new Types.ObjectId().toHexString(), scanJobId, 0),
    ).rejects.toThrow('Scan job not found');
    await service.onModuleDestroy();
  });

  it('returns persisted progress for polling when seq advances', async () => {
    const { service } = buildService();
    const latest = await service.getLatest(workspaceId, scanJobId, 4);
    expect(latest?.seq).toBe(5);
    const unchanged = await service.getLatest(workspaceId, scanJobId, 5);
    expect(unchanged).toBeNull();
    await service.onModuleDestroy();
  });

  it('sanitizes secrets from user-facing messages', async () => {
    const { service } = buildService();
    const event = await service.emit({
      workspaceId,
      scanJobId,
      type: ScanProgressEventType.WARNING,
      phase: ScanProgressPhase.ANALYZING,
      status: ScanJobStatus.RUNNING,
      message: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked',
      force: true,
    });
    expect(event?.message).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(event?.message).toContain('[REDACTED]');
    await service.onModuleDestroy();
  });
});
