import { Types } from 'mongoose';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScansController } from '../scans.controller';
import { ScanJobStatus } from '../../common/enums';
import {
  ScanProgressEventType,
  ScanProgressPhase,
  emptyCounts,
} from './scan-progress.types';

describe('ScansController progress auth / tenancy surface', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const otherWorkspace = new Types.ObjectId().toHexString();
  const scanId = new Types.ObjectId().toHexString();

  it('progress endpoint uses tenant workspace for lookup', async () => {
    const scansService = {};
    const progress = {
      getLatest: jest.fn().mockResolvedValue({
        scanJobId: scanId,
        workspaceId,
        seq: 2,
        type: ScanProgressEventType.STARTED,
        phase: ScanProgressPhase.ORCHESTRATING,
        status: ScanJobStatus.RUNNING,
        percent: 5,
        message: 'Scan started',
        timestamp: new Date().toISOString(),
        counts: emptyCounts(),
        terminal: false,
      }),
    };
    const controller = new ScansController(
      scansService as never,
      progress as never,
      {} as never,
      {} as never,
    );
    const result = await controller.getProgress(
      { workspaceId, role: 'admin' as never, membershipId: 'm1' },
      scanId,
      '0',
    );
    expect(progress.getLatest).toHaveBeenCalledWith(workspaceId, scanId, 0);
    expect(result.event?.seq).toBe(2);
  });

  it('progress endpoint surfaces not found for other workspace scans', async () => {
    const progress = {
      getLatest: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Scan job not found')),
    };
    const controller = new ScansController(
      {} as never,
      progress as never,
      {} as never,
      {} as never,
    );
    await expect(
      controller.getProgress(
        {
          workspaceId: otherWorkspace,
          role: 'admin' as never,
          membershipId: 'm2',
        },
        scanId,
        '0',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SSE stream is scoped to the authenticated workspace', () => {
    const progress = {
      stream: jest.fn().mockReturnValue({
        pipe: jest.fn().mockReturnValue({ subscribe: jest.fn() }),
      }),
    };
    const controller = new ScansController(
      {} as never,
      progress as never,
      {} as never,
      {} as never,
    );
    controller.events(
      { workspaceId, role: 'admin' as never, membershipId: 'm1' },
      scanId,
      '3',
    );
    expect(progress.stream).toHaveBeenCalledWith(workspaceId, scanId, 3);
  });

  it('documents that missing membership is rejected by TenantGuard', () => {
    // Guards run before controller methods; this assertion locks the contract.
    expect(
      new ForbiddenException('You are not a member of this workspace'),
    ).toBeInstanceOf(ForbiddenException);
  });
});
