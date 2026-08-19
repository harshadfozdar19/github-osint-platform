import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { KeywordRotationService } from './keyword-rotation.service';

describe('KeywordRotationService', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const brandId = new Types.ObjectId().toHexString();
  const otherBrandId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();

  function buildDoc(overrides: Record<string, unknown> = {}) {
    const doc: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
      enabled: false,
      slots: [],
      currentIndex: 0,
      cyclesCompleted: 0,
      dateFilterMode: 'any',
      lastError: '',
      currentSlotExtensions: 0,
      save: jest.fn().mockResolvedValue(undefined),
      markModified: jest.fn(),
      ...overrides,
    };
    return doc;
  }

  function buildService(opts: {
    existingDoc?: Record<string, unknown> | null;
    brands?: Record<string, unknown>[];
    enqueueManualScan?: jest.Mock;
    cancelScan?: jest.Mock;
    getScanPausedUntil?: jest.Mock;
  }) {
    const doc = opts.existingDoc ?? null;
    const newDocInstances: Record<string, unknown>[] = [];

    function RotationModelCtor(
      this: Record<string, unknown>,
      init: Record<string, unknown>,
    ) {
      Object.assign(this, buildDoc(init));
      newDocInstances.push(this);
    }
    const rotationModel = Object.assign(RotationModelCtor, {
      findOne: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(doc),
        lean: () => ({ exec: () => Promise.resolve(doc) }),
      }),
    });

    const defaultBrands = [
      { _id: brandId, keywords: ['alpha', 'beta', 'gamma'] },
      { _id: otherBrandId, keywords: ['delta'] },
    ];
    const brandModel = {
      find: jest.fn().mockReturnValue({
        select: () => ({
          lean: () => ({
            exec: () => Promise.resolve(opts.brands ?? defaultBrands),
          }),
        }),
      }),
    };

    const rotationQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const scanQueue = {
      enqueueManualScan:
        opts.enqueueManualScan ??
        jest
          .fn()
          .mockResolvedValue({ _id: new Types.ObjectId().toHexString() }),
      cancelScan: opts.cancelScan ?? jest.fn().mockResolvedValue(undefined),
    };

    const github = {
      getScanPausedUntil:
        opts.getScanPausedUntil ?? jest.fn().mockResolvedValue(null),
    };

    const service = new KeywordRotationService(
      rotationModel as never,
      brandModel as never,
      rotationQueue as never,
      scanQueue as never,
      github as never,
    );
    return {
      service,
      rotationQueue,
      scanQueue,
      brandModel,
      github,
      newDocInstances,
    };
  }

  describe('start', () => {
    it('rejects an empty slots queue', async () => {
      const { service } = buildService({});
      await expect(
        service.start(workspaceId, userId, { slots: [] }),
      ).rejects.toThrow();
    });

    it('rejects a slot duration outside 1s..24h', async () => {
      const { service } = buildService({});
      await expect(
        service.start(workspaceId, userId, {
          slots: [{ brandId, keyword: 'alpha', durationMs: 0 }],
        }),
      ).rejects.toThrow();
      await expect(
        service.start(workspaceId, userId, {
          slots: [{ brandId, keyword: 'alpha', durationMs: 25 * 60 * 60_000 }],
        }),
      ).rejects.toThrow();
    });

    it("rejects a keyword that isn't one of its own company's own", async () => {
      const { service } = buildService({});
      await expect(
        service.start(workspaceId, userId, {
          slots: [
            { brandId, keyword: 'not-a-real-keyword', durationMs: 30_000 },
          ],
        }),
      ).rejects.toThrow();
    });

    it('rejects an invalid searchScope on a slot', async () => {
      const { service } = buildService({});
      await expect(
        service.start(workspaceId, userId, {
          slots: [
            {
              brandId,
              keyword: 'alpha',
              durationMs: 30_000,
              searchScope: 'nonsense' as never,
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it("defaults a slot's searchScope to 'both' when omitted, and passes through a given one to the enqueued scan", async () => {
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          {
            brandId,
            keyword: 'beta',
            durationMs: 30_000,
            searchScope: 'code',
          },
        ],
      });

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        userId,
        expect.objectContaining({ keyword: 'alpha', searchScope: 'both' }),
      );
    });

    it("defaults a slot's continueDiscovery to true when omitted", async () => {
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        userId,
        expect.objectContaining({ keyword: 'alpha', continueDiscovery: true }),
      );
    });

    it('passes through an explicit continueDiscovery: false to the enqueued scan', async () => {
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [
          {
            brandId,
            keyword: 'beta',
            durationMs: 30_000,
            continueDiscovery: false,
          },
        ],
      });

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        userId,
        expect.objectContaining({
          keyword: 'beta',
          continueDiscovery: false,
        }),
      );
    });

    it('enqueues a rotationManaged, continueDiscovery, discoveryOnly scan for the first queued keyword (with its own company) and schedules its own delayed advance', async () => {
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service, rotationQueue } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [
          { brandId, keyword: 'alpha', durationMs: 45_000 },
          { brandId: otherBrandId, keyword: 'delta', durationMs: 90_000 },
        ],
      });

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        userId,
        expect.objectContaining({
          brandId,
          keyword: 'alpha',
          discoveryOnly: true,
          continueDiscovery: true,
          rotationManaged: true,
        }),
      );
      expect(rotationQueue.add).toHaveBeenCalledWith(
        'advance',
        expect.objectContaining({ workspaceId }),
        expect.objectContaining({ delay: 45_000 }),
      );
    });

    it('mixes keywords from different companies in one queue, run in the exact order given', async () => {
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service, rotationQueue } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [
          { brandId: otherBrandId, keyword: 'delta', durationMs: 20_000 },
          { brandId, keyword: 'alpha', durationMs: 200_000 },
        ],
      });

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        userId,
        expect.objectContaining({ brandId: otherBrandId, keyword: 'delta' }),
      );
      expect(rotationQueue.add).toHaveBeenCalledWith(
        'advance',
        expect.anything(),
        expect.objectContaining({ delay: 20_000 }),
      );
    });

    it('applies the dated filter (createdFrom/createdTo, OR mode) when dateFilterMode is "dated"', async () => {
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
        dateFilterMode: 'dated',
        createdFrom: '2026-01-01',
        createdTo: '2026-08-12',
      });

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        userId,
        expect.objectContaining({
          createdFrom: '2026-01-01',
          createdTo: '2026-08-12',
          dateFilterMode: 'or',
        }),
      );
    });

    it('sends no date qualifiers at all when dateFilterMode is "any" (the default)', async () => {
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });

      const call = enqueueManualScan.mock.calls[0][2] as Record<
        string,
        unknown
      >;
      expect(call.createdFrom).toBeUndefined();
      expect(call.createdTo).toBeUndefined();
      expect(call.dateFilterMode).toBeUndefined();
    });

    it('skips a keyword whose independent watch-toggle scan already conflicts, and starts the next queued one instead', async () => {
      const enqueueManualScan = jest
        .fn()
        .mockRejectedValueOnce(new ConflictException('already active'))
        .mockResolvedValueOnce({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
      });

      expect(enqueueManualScan).toHaveBeenCalledTimes(2);
      expect(enqueueManualScan.mock.calls[0][2]).toEqual(
        expect.objectContaining({ keyword: 'alpha' }),
      );
      expect(enqueueManualScan.mock.calls[1][2]).toEqual(
        expect.objectContaining({ keyword: 'beta' }),
      );
    });

    it('disables itself with lastError when every queued keyword conflicts', async () => {
      const enqueueManualScan = jest
        .fn()
        .mockRejectedValue(new ConflictException('already active'));
      const { service, newDocInstances } = buildService({ enqueueManualScan });

      await service.start(workspaceId, userId, {
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
          { brandId, keyword: 'gamma', durationMs: 30_000 },
        ],
      });

      expect(enqueueManualScan).toHaveBeenCalledTimes(3);
      const doc = newDocInstances[0];
      expect(doc.enabled).toBe(false);
      expect(doc.lastError).toContain("Couldn't start");
    });
  });

  describe('stop', () => {
    it('cancels the current scan and the pending advance timer, then disables the rotation', async () => {
      const cancelScan = jest.fn().mockResolvedValue(undefined);
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
        currentScanJobId,
        pendingAdvanceToken: 'tok-1',
      });
      const { service, rotationQueue } = buildService({
        existingDoc,
        cancelScan,
      });

      await service.stop(workspaceId);

      expect(cancelScan).toHaveBeenCalledWith(
        workspaceId,
        String(currentScanJobId),
      );
      expect(rotationQueue.remove).toHaveBeenCalled();
      expect(existingDoc.enabled).toBe(false);
    });

    it('is a safe no-op when no rotation is running', async () => {
      const { service, scanQueue } = buildService({ existingDoc: null });
      await service.stop(workspaceId);
      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
    });
  });

  describe('advance', () => {
    it('ignores a stale timer whose token no longer matches the rotation doc', async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        pendingAdvanceToken: 'current-token',
      });
      const { service, scanQueue } = buildService({ existingDoc });

      await service.advance(workspaceId, { token: 'stale-token' });

      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
    });

    it('no-ops when the rotation was stopped before the timer fired', async () => {
      const { service, scanQueue } = buildService({ existingDoc: null });
      await service.advance(workspaceId, { token: 'whatever' });
      expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
    });

    it("wraps around to index 0 and increments cyclesCompleted after the last queued keyword, using that keyword's own company + duration for the new turn", async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 12_345 },
          { brandId: otherBrandId, keyword: 'delta', durationMs: 30_000 },
        ],
        currentIndex: 1,
        currentScanJobId,
        pendingAdvanceToken: 'tok-1',
        cyclesCompleted: 2,
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service, rotationQueue } = buildService({
        existingDoc,
        enqueueManualScan,
      });

      await service.advance(workspaceId, { token: 'tok-1' });

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ brandId, keyword: 'alpha' }),
      );
      expect(rotationQueue.add).toHaveBeenCalledWith(
        'advance',
        expect.anything(),
        expect.objectContaining({ delay: 12_345 }),
      );
      expect(existingDoc.cyclesCompleted).toBe(3);
      expect(existingDoc.currentIndex).toBe(0);
    });

    it("extends the current slot instead of handing off when the keyword's scan is still paused for GitHub quota - the whole point being that a slot that never got to do any real work shouldn't just be cut off on schedule anyway", async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 300_000 },
          { brandId: otherBrandId, keyword: 'delta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
        pendingAdvanceToken: 'tok-1',
        currentSlotExtensions: 0,
      });
      const pausedUntil = Date.now() + 20_000;
      const { service, scanQueue, rotationQueue } = buildService({
        existingDoc,
        getScanPausedUntil: jest.fn().mockResolvedValue(pausedUntil),
      });

      await service.advance(workspaceId, { token: 'tok-1' });

      // Never cancelled/handed off - still the same keyword, same index.
      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
      expect(existingDoc.currentIndex).toBe(0);
      expect(existingDoc.currentSlotExtensions).toBe(1);
      // New delayed 'advance' job covers the remaining pause plus a working
      // buffer - a small range, not an exact value, since the remaining
      // pause is itself computed from a fresh Date.now() call inside the
      // implementation, a few ms after pausedUntil was captured above.
      const call = rotationQueue.add.mock.calls[0] as [
        string,
        unknown,
        { delay: number },
      ];
      expect(call[0]).toBe('advance');
      expect(call[2].delay).toBeGreaterThan(49_000);
      expect(call[2].delay).toBeLessThanOrEqual(50_000);
    });

    it('hands off normally once the extension budget for this slot is used up, even if still paused - a persistently-blocked keyword must not monopolize the whole queue', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 300_000 },
          { brandId: otherBrandId, keyword: 'delta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
        pendingAdvanceToken: 'tok-1',
        currentSlotExtensions: 3, // already at MAX_SLOT_QUOTA_EXTENSIONS
      });
      const { service, scanQueue } = buildService({
        existingDoc,
        getScanPausedUntil: jest.fn().mockResolvedValue(Date.now() + 20_000),
      });

      await service.advance(workspaceId, { token: 'tok-1' });

      expect(scanQueue.cancelScan).toHaveBeenCalled();
      expect(scanQueue.enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ brandId: otherBrandId, keyword: 'delta' }),
      );
    });

    it('caps a single extension rather than waiting out a much-further-out pause (e.g. a daily budget that resets hours from now) - better to hand off than block every other queued keyword for hours', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 300_000 },
          { brandId: otherBrandId, keyword: 'delta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
        pendingAdvanceToken: 'tok-1',
        currentSlotExtensions: 0,
      });
      const { service, rotationQueue } = buildService({
        existingDoc,
        getScanPausedUntil: jest
          .fn()
          .mockResolvedValue(Date.now() + 2 * 60 * 60_000), // 2 hours out
      });

      await service.advance(workspaceId, { token: 'tok-1' });

      expect(rotationQueue.add).toHaveBeenCalledWith(
        'advance',
        expect.anything(),
        expect.objectContaining({ delay: 10 * 60_000 }), // MAX_SINGLE_QUOTA_EXTENSION_MS
      );
    });

    it('proceeds with the normal handoff when the current scan is not paused at all', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 300_000 },
          { brandId: otherBrandId, keyword: 'delta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
        pendingAdvanceToken: 'tok-1',
      });
      const { service, scanQueue } = buildService({
        existingDoc,
        getScanPausedUntil: jest.fn().mockResolvedValue(null),
      });

      await service.advance(workspaceId, { token: 'tok-1' });

      expect(scanQueue.cancelScan).toHaveBeenCalled();
      expect(scanQueue.enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ brandId: otherBrandId, keyword: 'delta' }),
      );
    });

    it('resets the extension counter to 0 once a genuinely new slot starts, so the next keyword gets its own full extension budget', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 300_000 },
          { brandId: otherBrandId, keyword: 'delta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
        pendingAdvanceToken: 'tok-1',
        currentSlotExtensions: 2,
      });
      const { service } = buildService({
        existingDoc,
        getScanPausedUntil: jest.fn().mockResolvedValue(null),
      });

      await service.advance(workspaceId, { token: 'tok-1' });

      expect(existingDoc.currentSlotExtensions).toBe(0);
    });
  });

  describe('addSlots', () => {
    it("rejects adding to a scheduler that isn't currently running", async () => {
      const existingDoc = buildDoc({ enabled: false, slots: [] });
      const { service } = buildService({ existingDoc });

      await expect(
        service.addSlots(workspaceId, [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
        ]),
      ).rejects.toThrow();
    });

    it('rejects adding to a workspace with no scheduler at all', async () => {
      const { service } = buildService({ existingDoc: null });
      await expect(
        service.addSlots(workspaceId, [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
        ]),
      ).rejects.toThrow();
    });

    it("appends new keywords to the end of the queue without touching what's already running", async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
        currentIndex: 0,
        currentScanJobId,
      });
      const { service, scanQueue } = buildService({ existingDoc });

      await service.addSlots(workspaceId, [
        { brandId, keyword: 'beta', durationMs: 45_000 },
      ]);

      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect(scanQueue.enqueueManualScan).not.toHaveBeenCalled();
      expect(existingDoc.currentIndex).toBe(0);
      expect(
        (existingDoc.slots as { keyword: string }[]).map((s) => s.keyword),
      ).toEqual(['alpha', 'beta']);
    });

    it('silently drops a duplicate of a company+keyword pair already queued instead of erroring', async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
        currentIndex: 0,
        currentScanJobId: new Types.ObjectId(),
      });
      const { service } = buildService({ existingDoc });

      await service.addSlots(workspaceId, [
        { brandId, keyword: 'alpha', durationMs: 60_000 },
        { brandId, keyword: 'beta', durationMs: 30_000 },
      ]);

      expect(
        (existingDoc.slots as { keyword: string }[]).map((s) => s.keyword),
      ).toEqual(['alpha', 'beta']);
    });

    it("rejects a keyword that isn't one of that company's own", async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });
      const { service } = buildService({ existingDoc });

      await expect(
        service.addSlots(workspaceId, [
          { brandId, keyword: 'not-a-real-keyword', durationMs: 30_000 },
        ]),
      ).rejects.toThrow();
    });
  });

  describe('pauseSlot', () => {
    it('pausing a slot that is NOT currently running just flags it, without touching the active scan or any other slot', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const { service, scanQueue } = buildService({ existingDoc });

      await service.pauseSlot(workspaceId, brandId, 'beta');

      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect((existingDoc.slots as { paused?: boolean }[])[1].paused).toBe(
        true,
      );
      expect(
        (existingDoc.slots as { paused?: boolean }[])[0].paused,
      ).toBeUndefined();
    });

    it('pausing the CURRENTLY running slot cancels its scan and hands off immediately to the next non-paused one', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 45_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service, scanQueue } = buildService({
        existingDoc,
        enqueueManualScan,
      });

      await service.pauseSlot(workspaceId, brandId, 'alpha');

      expect(scanQueue.cancelScan).toHaveBeenCalledWith(
        workspaceId,
        String(currentScanJobId),
      );
      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ keyword: 'beta' }),
      );
      expect(existingDoc.currentIndex).toBe(1);
    });

    it('disables the whole rotation once every slot ends up paused', async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000, paused: true },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 1,
        currentScanJobId: new Types.ObjectId(),
      });
      const { service } = buildService({ existingDoc });

      await service.pauseSlot(workspaceId, brandId, 'beta');

      expect(existingDoc.enabled).toBe(false);
      expect(existingDoc.lastError).toContain(
        'Every keyword in the queue is paused',
      );
    });

    it("throws when the keyword isn't in the queue", async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });
      const { service } = buildService({ existingDoc });

      await expect(
        service.pauseSlot(workspaceId, brandId, 'not-queued'),
      ).rejects.toThrow();
    });
  });

  describe('setSlotSearchScope', () => {
    it('changing the search scope of a slot that is NOT currently running just updates it, without touching the active scan', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const enqueueManualScan = jest.fn();
      const { service, scanQueue } = buildService({
        existingDoc,
        enqueueManualScan,
      });

      await service.setSlotSearchScope(workspaceId, brandId, 'beta', 'code');

      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect(enqueueManualScan).not.toHaveBeenCalled();
      expect(
        (existingDoc.slots as { searchScope?: string }[])[1].searchScope,
      ).toBe('code');
    });

    it('changing the search scope of the CURRENTLY running slot cancels and immediately restarts its own scan with the new scope, not the next one', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 45_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service, scanQueue } = buildService({
        existingDoc,
        enqueueManualScan,
      });

      await service.setSlotSearchScope(
        workspaceId,
        brandId,
        'alpha',
        'repositories',
      );

      expect(scanQueue.cancelScan).toHaveBeenCalledWith(
        workspaceId,
        String(currentScanJobId),
      );
      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({
          keyword: 'alpha',
          searchScope: 'repositories',
        }),
      );
      // Restarted the SAME slot (index 0), not handed off to the next one.
      expect(existingDoc.currentIndex).toBe(0);
    });

    it('rejects an invalid search scope', async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });
      const { service } = buildService({ existingDoc });

      await expect(
        service.setSlotSearchScope(
          workspaceId,
          brandId,
          'alpha',
          'nonsense' as never,
        ),
      ).rejects.toThrow();
    });

    it("throws when the keyword isn't in the queue", async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });
      const { service } = buildService({ existingDoc });

      await expect(
        service.setSlotSearchScope(workspaceId, brandId, 'not-queued', 'code'),
      ).rejects.toThrow();
    });
  });

  describe('setSlotContinueDiscovery', () => {
    it('changing a slot that is NOT currently running just updates it, without touching the active scan', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const enqueueManualScan = jest.fn();
      const { service, scanQueue } = buildService({
        existingDoc,
        enqueueManualScan,
      });

      await service.setSlotContinueDiscovery(
        workspaceId,
        brandId,
        'beta',
        false,
      );

      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect(enqueueManualScan).not.toHaveBeenCalled();
      expect(
        (existingDoc.slots as { continueDiscovery?: boolean }[])[1]
          .continueDiscovery,
      ).toBe(false);
    });

    it('changing the CURRENTLY running slot cancels and immediately restarts its own scan with the new choice, not the next one', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 45_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service, scanQueue } = buildService({
        existingDoc,
        enqueueManualScan,
      });

      await service.setSlotContinueDiscovery(
        workspaceId,
        brandId,
        'alpha',
        false,
      );

      expect(scanQueue.cancelScan).toHaveBeenCalledWith(
        workspaceId,
        String(currentScanJobId),
      );
      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({
          keyword: 'alpha',
          continueDiscovery: false,
        }),
      );
      expect(existingDoc.currentIndex).toBe(0);
    });

    it("throws when the keyword isn't in the queue", async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });
      const { service } = buildService({ existingDoc });

      await expect(
        service.setSlotContinueDiscovery(
          workspaceId,
          brandId,
          'not-queued',
          false,
        ),
      ).rejects.toThrow();
    });
  });

  describe('resumeSlot', () => {
    it('resuming a slot while the rotation is still running just clears the flag, without starting a new scan', async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000, paused: true },
        ],
        currentIndex: 0,
        currentScanJobId: new Types.ObjectId(),
      });
      const enqueueManualScan = jest.fn();
      const { service } = buildService({ existingDoc, enqueueManualScan });

      await service.resumeSlot(workspaceId, brandId, 'beta');

      expect(enqueueManualScan).not.toHaveBeenCalled();
      expect((existingDoc.slots as { paused?: boolean }[])[1].paused).toBe(
        false,
      );
    });

    it('resuming a slot after the whole rotation had stopped restarts it from that slot right away', async () => {
      const existingDoc = buildDoc({
        enabled: false,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000, paused: true },
        ],
        currentIndex: 0,
        lastError:
          'Every keyword in the queue is paused - resume at least one to keep the scheduler running.',
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ existingDoc, enqueueManualScan });

      await service.resumeSlot(workspaceId, brandId, 'beta');

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ keyword: 'beta' }),
      );
      expect(existingDoc.enabled).toBe(true);
    });

    it('resuming a slot on a rotation stuck claiming enabled=true with no scan running and no pending handoff restarts it, same as if it had stopped', async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000, paused: true },
          { brandId, keyword: 'beta', durationMs: 30_000, paused: true },
        ],
        currentIndex: 0,
        currentScanJobId: undefined,
        pendingAdvanceToken: undefined,
        lastError:
          'Every keyword in the queue is paused - resume at least one to keep the scheduler running.',
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({ existingDoc, enqueueManualScan });

      await service.resumeSlot(workspaceId, brandId, 'beta');

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ keyword: 'beta' }),
      );
      expect(existingDoc.enabled).toBe(true);
      expect(existingDoc.lastError).toBe('');
    });
  });

  describe('recoverStalledRotations (watchdog)', () => {
    it('restarts a rotation left enabled=true with no active scan and no pending handoff timer', async () => {
      const existingDoc = buildDoc({
        workspaceId: new Types.ObjectId(workspaceId),
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000, paused: true },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId: undefined,
        pendingAdvanceToken: undefined,
        lastError: 'stale error from a past failure',
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service } = buildService({
        existingDoc: null,
        enqueueManualScan,
      });
      (
        service as unknown as { rotationModel: { find: jest.Mock } }
      ).rotationModel.find = jest.fn().mockReturnValue({
        exec: () => Promise.resolve([existingDoc]),
      });

      await (
        service as unknown as {
          recoverStalledRotations: () => Promise<void>;
        }
      ).recoverStalledRotations();

      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ keyword: 'beta' }),
      );
      expect(existingDoc.currentIndex).toBe(1);
      expect(existingDoc.lastError).toBe('');
    });

    it('leaves genuinely idle (disabled) rotations alone', async () => {
      const { service } = buildService({ existingDoc: null });
      const find = jest.fn().mockReturnValue({
        exec: () => Promise.resolve([]),
      });
      (
        service as unknown as { rotationModel: { find: jest.Mock } }
      ).rotationModel.find = find;

      await (
        service as unknown as {
          recoverStalledRotations: () => Promise<void>;
        }
      ).recoverStalledRotations();

      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          currentScanJobId: { $exists: false },
          pendingAdvanceToken: { $exists: false },
        }),
      );
    });
  });

  describe('removeSlot', () => {
    it('removing a slot that is NOT currently running just splices it out, without touching the active scan', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const { service, scanQueue } = buildService({ existingDoc });

      await service.removeSlot(workspaceId, brandId, 'beta');

      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect(existingDoc.slots).toHaveLength(1);
      expect((existingDoc.slots as { keyword: string }[])[0].keyword).toBe(
        'alpha',
      );
      expect(existingDoc.currentIndex).toBe(0);
    });

    it('removing a slot BEFORE the currently running one shifts currentIndex left to keep pointing at the same slot', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 30_000 },
        ],
        currentIndex: 1,
        currentScanJobId,
      });
      const { service, scanQueue } = buildService({ existingDoc });

      await service.removeSlot(workspaceId, brandId, 'alpha');

      expect(scanQueue.cancelScan).not.toHaveBeenCalled();
      expect(existingDoc.slots).toHaveLength(1);
      expect(existingDoc.currentIndex).toBe(0);
    });

    it('removing the CURRENTLY running slot cancels its scan and hands off immediately to the slot that follows it', async () => {
      const currentScanJobId = new Types.ObjectId();
      const existingDoc = buildDoc({
        enabled: true,
        slots: [
          { brandId, keyword: 'alpha', durationMs: 30_000 },
          { brandId, keyword: 'beta', durationMs: 45_000 },
        ],
        currentIndex: 0,
        currentScanJobId,
      });
      const enqueueManualScan = jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId().toHexString() });
      const { service, scanQueue } = buildService({
        existingDoc,
        enqueueManualScan,
      });

      await service.removeSlot(workspaceId, brandId, 'alpha');

      expect(scanQueue.cancelScan).toHaveBeenCalledWith(
        workspaceId,
        String(currentScanJobId),
      );
      expect(existingDoc.slots).toHaveLength(1);
      expect(enqueueManualScan).toHaveBeenCalledWith(
        workspaceId,
        String(existingDoc.triggeredBy),
        expect.objectContaining({ keyword: 'beta' }),
      );
      expect(existingDoc.currentIndex).toBe(0);
    });

    it('disables the whole rotation once the last remaining slot is removed', async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
        currentIndex: 0,
        currentScanJobId: new Types.ObjectId(),
      });
      const { service, scanQueue } = buildService({ existingDoc });

      await service.removeSlot(workspaceId, brandId, 'alpha');

      expect(scanQueue.cancelScan).toHaveBeenCalled();
      expect(existingDoc.slots).toHaveLength(0);
      expect(existingDoc.enabled).toBe(false);
      expect(existingDoc.currentScanJobId).toBeUndefined();
    });

    it("throws when the keyword isn't in the queue", async () => {
      const existingDoc = buildDoc({
        enabled: true,
        slots: [{ brandId, keyword: 'alpha', durationMs: 30_000 }],
      });
      const { service } = buildService({ existingDoc });

      await expect(
        service.removeSlot(workspaceId, brandId, 'not-queued'),
      ).rejects.toThrow();
    });
  });
});
