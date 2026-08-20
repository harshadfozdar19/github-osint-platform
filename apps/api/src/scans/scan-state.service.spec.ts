import { ScanJobStatus } from '../common/enums';
import { ScanStateService } from './scan-state.service';

describe('ScanStateService.completeAnalysisUnit', () => {
  function buildService(runningJob: Record<string, unknown> = {}) {
    const findByIdAndUpdate = jest.fn().mockResolvedValue({});
    const findById = jest.fn().mockReturnValue({
      exec: () =>
        Promise.resolve({
          status: ScanJobStatus.RUNNING,
          cancelRequested: false,
          awaitingSearch: 1,
          awaitingAnalysis: 1,
          ...runningJob,
        }),
    });
    const scanModel = { findByIdAndUpdate, findById };
    const progress = { emitFromScanId: jest.fn().mockResolvedValue(null) };
    const scanQueue = { enqueueManualScan: jest.fn().mockResolvedValue({}) };
    const service = new ScanStateService(
      scanModel as never,
      progress as never,
      scanQueue as never,
    );
    return { service, findByIdAndUpdate };
  }

  it('increments findingsHighRisk when a high/critical-severity finding was produced', async () => {
    const { service, findByIdAndUpdate } = buildService();
    await service.completeAnalysisUnit('scan-1', {
      findingsCreated: 1,
      findingsNew: 1,
      findingsHighRisk: 1,
      rescanned: true,
      githubId: 42,
    });
    const update = findByIdAndUpdate.mock.calls[0][1] as {
      $inc: Record<string, number>;
    };
    expect(update.$inc.findingsHighRisk).toBe(1);
  });

  it('does not set findingsHighRisk in the update when the repo was not high-risk', async () => {
    const { service, findByIdAndUpdate } = buildService();
    await service.completeAnalysisUnit('scan-1', {
      findingsCreated: 1,
      findingsNew: 1,
      findingsHighRisk: 0,
      rescanned: true,
      githubId: 42,
    });
    const update = findByIdAndUpdate.mock.calls[0][1] as {
      $inc: Record<string, number>;
    };
    expect(update.$inc.findingsHighRisk).toBeUndefined();
  });
});

describe('ScanStateService.finalize keyword-watch auto-restart', () => {
  const workspaceId = '507f1f77bcf86cd799439011';
  const scopeBrandId = '507f1f77bcf86cd799439012';
  const triggeredBy = '507f1f77bcf86cd799439013';

  function buildService(jobOverrides: Record<string, unknown>) {
    const doc = {
      _id: 'scan-1',
      workspaceId,
      status: ScanJobStatus.RUNNING,
      cancelRequested: false,
      reposFailed: 0,
      reposProcessed: 0,
      error: '',
      triggeredBy,
      discoveryOnly: true,
      maxRepos: 500,
      save: jest.fn(),
      ...jobOverrides,
    };
    const scanModel = {
      findById: jest.fn().mockReturnValue({ exec: () => Promise.resolve(doc) }),
    };
    const progress = { emitFromScanId: jest.fn().mockResolvedValue(null) };
    const scanQueue = { enqueueManualScan: jest.fn().mockResolvedValue({}) };
    const service = new ScanStateService(
      scanModel as never,
      progress as never,
      scanQueue as never,
    );
    return { service, scanQueue };
  }

  it('re-enqueues the same keyword-scoped discoveryOnly scan (delayed, resuming from its cursor) once it cleanly completes', async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
    });
    await service.finalize('scan-1');
    expect(scanQueue.enqueueManualScan).toHaveBeenCalledWith(
      workspaceId,
      triggeredBy,
      expect.objectContaining({
        brandId: scopeBrandId,
        keyword: 'otp bypass',
        discoveryOnly: true,
        continueDiscovery: true,
        delayMs: expect.any(Number),
      }),
    );
  });

  it('uses a flat ~30s cooldown regardless of whether the run that just finished found anything new', async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
      reposDiscovered: 5,
    });
    await service.finalize('scan-1');
    const call = scanQueue.enqueueManualScan.mock.calls[0][2] as {
      delayMs: number;
    };
    expect(call.delayMs).toBe(30_000);
  });

  it('uses the same ~30s cooldown when the run found nothing new too', async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
      reposDiscovered: 0,
    });
    await service.finalize('scan-1');
    const call = scanQueue.enqueueManualScan.mock.calls[0][2] as {
      delayMs: number;
    };
    expect(call.delayMs).toBe(30_000);
  });

  it("does NOT restart a scan the user explicitly cancelled - 'off' must mean off", async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
      cancelRequested: true,
    });
    await service.finalize('scan-1');
    expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
  });

  it('does not restart a scan that finished with an error (e.g. auth failure) - would just repeat the same failure forever', async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
      error: 'GitHub authentication failed (401 Unauthorized)',
    });
    await service.finalize('scan-1');
    expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
  });

  it('does not restart a scan that is not keyword-scoped (e.g. a full brand sweep or custom query scan)', async () => {
    const { service, scanQueue } = buildService({});
    await service.finalize('scan-1');
    expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
  });

  it('does not restart a rotation-managed scan - KeywordRotationService.advance owns what runs next for it', async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
      rotationManaged: true,
    });
    await service.finalize('scan-1');
    expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
  });

  it('does not restart a non-discoveryOnly keyword scan (e.g. analyze_pending style full analysis)', async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
      discoveryOnly: false,
    });
    await service.finalize('scan-1');
    expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
  });

  it('swallows a restart failure (e.g. brand deleted) instead of throwing out of finalize', async () => {
    const { service, scanQueue } = buildService({
      scopeKeyword: 'otp bypass',
      scopeBrandId,
    });
    scanQueue.enqueueManualScan.mockRejectedValueOnce(
      new Error('Brand not found'),
    );
    await expect(service.finalize('scan-1')).resolves.toBeDefined();
  });
});
