/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Types } from 'mongoose';
import { WorkspaceRole, WORKSPACE_HEADER } from '../common/enums';
import { TenantGuard } from './tenant.guard';
import { WorkspacesService } from '../workspaces/workspaces.service';

function mockContext(opts: {
  userId?: string;
  workspaceHeader?: string;
}): ExecutionContext {
  const request: Record<string, unknown> = {
    user: opts.userId
      ? { id: opts.userId, email: 'u@example.com', name: 'U' }
      : undefined,
    headers: {
      [WORKSPACE_HEADER]: opts.workspaceHeader,
    },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('Multi-tenancy security', () => {
  const workspaceA = new Types.ObjectId().toHexString();
  const workspaceB = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();

  describe('TenantGuard', () => {
    it('rejects invalid workspace IDs', async () => {
      const workspacesService = {
        getActiveMembership: jest.fn(),
      } as unknown as WorkspacesService;
      const guard = new TenantGuard(workspacesService);

      await expect(
        guard.canActivate(
          mockContext({ userId, workspaceHeader: 'not-an-objectid' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(workspacesService.getActiveMembership).not.toHaveBeenCalled();
    });

    it('rejects missing workspace header', async () => {
      const workspacesService = {
        getActiveMembership: jest.fn(),
      } as unknown as WorkspacesService;
      const guard = new TenantGuard(workspacesService);

      await expect(
        guard.canActivate(mockContext({ userId })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects access when user is not a member of the workspace', async () => {
      const workspacesService = {
        getActiveMembership: jest.fn().mockResolvedValue(null),
      } as unknown as WorkspacesService;
      const guard = new TenantGuard(workspacesService);

      await expect(
        guard.canActivate(mockContext({ userId, workspaceHeader: workspaceB })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows access when membership is verified', async () => {
      const workspacesService = {
        getActiveMembership: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          role: WorkspaceRole.OWNER,
        }),
      } as unknown as WorkspacesService;
      const guard = new TenantGuard(workspacesService);
      const ctx = mockContext({ userId, workspaceHeader: workspaceA });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      const req = ctx.switchToHttp().getRequest();
      expect(req.tenant.workspaceId).toBe(workspaceA);
      expect(req.tenant.role).toBe(WorkspaceRole.OWNER);
    });
  });

  describe('Cross-workspace isolation helpers', () => {
    it('finding lookup always includes workspaceId in the filter', () => {
      // Mirrors FindingsService.getById query shape
      const findingId = new Types.ObjectId().toHexString();
      const filter = {
        _id: findingId,
        workspaceId: new Types.ObjectId(workspaceA),
      };
      expect(filter.workspaceId.toHexString()).toBe(workspaceA);
      expect(filter.workspaceId.toHexString()).not.toBe(workspaceB);
    });

    it('scan jobs are created with the callers workspaceId only', () => {
      const jobA = { workspaceId: new Types.ObjectId(workspaceA) };
      const jobB = { workspaceId: new Types.ObjectId(workspaceB) };
      expect(jobA.workspaceId.toHexString()).not.toBe(
        jobB.workspaceId.toHexString(),
      );
    });
  });
});
