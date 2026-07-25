import { Types } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import { FindingsService } from './findings.service';
import { FindingStatus } from '../common/enums';

describe('FindingsService.getById', () => {
  it('queries detections with findingId cast to a real ObjectId, not a string', async () => {
    // Regression test: Mongoose reliably auto-casts a plain string for the
    // special `_id` field, but does NOT reliably do so for a regular
    // ObjectId-typed field like `findingId` - passing the raw route-param
    // string there silently matched zero documents even when matching
    // detections existed in the database.
    const id = new Types.ObjectId().toHexString();
    const workspaceId = new Types.ObjectId().toHexString();

    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ _id: id, summary: 'test' }),
      }),
    };
    const findSpy = jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });
    const detectionModel = { find: findSpy };
    const repoModel = {};

    const service = new FindingsService(
      findingModel as never,
      detectionModel as never,
      repoModel as never,
    );

    await service.getById(workspaceId, id);

    expect(findSpy).toHaveBeenCalledTimes(1);
    const filter = findSpy.mock.calls[0][0] as {
      findingId: unknown;
      workspaceId: unknown;
    };
    expect(filter.findingId).toBeInstanceOf(Types.ObjectId);
    expect((filter.findingId as Types.ObjectId).toHexString()).toBe(id);
    expect(filter.workspaceId).toBeInstanceOf(Types.ObjectId);
  });

  it('throws NotFoundException for a malformed id', async () => {
    const service = new FindingsService({} as never, {} as never, {} as never);
    await expect(
      service.getById(new Types.ObjectId().toHexString(), 'not-an-object-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when no matching finding exists', async () => {
    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      }),
    };
    const service = new FindingsService(
      findingModel as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.getById(
        new Types.ObjectId().toHexString(),
        new Types.ObjectId().toHexString(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the finding merged with its detections', async () => {
    const id = new Types.ObjectId().toHexString();
    const workspaceId = new Types.ObjectId().toHexString();
    const detections = [
      { ruleId: 'secret-aws-key', file: '.env', lineNumber: 3 },
    ];

    const findingModel = {
      findOne: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ _id: id, severity: 'critical' }),
      }),
    };
    const detectionModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(detections),
      }),
    };

    const service = new FindingsService(
      findingModel as never,
      detectionModel as never,
      {} as never,
    );

    const result = await service.getById(workspaceId, id);
    expect(result.detections).toEqual(detections);
    expect(result.severity).toBe('critical');
  });
});

describe('FindingsService.updateStatus', () => {
  it('rejects an invalid status value', async () => {
    const service = new FindingsService({} as never, {} as never, {} as never);
    await expect(
      service.updateStatus(
        new Types.ObjectId().toHexString(),
        new Types.ObjectId().toHexString(),
        new Types.ObjectId().toHexString(),
        { status: 'not-a-real-status' as FindingStatus },
      ),
    ).rejects.toThrow();
  });
});
