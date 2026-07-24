import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { WORKSPACE_HEADER } from '../common/enums';
import type { AuthUser } from '../auth/current-user.decorator';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { TenantContext } from './tenancy.decorators';

/**
 * Resolves and verifies workspace membership from X-Workspace-Id.
 * Never trusts a client-supplied workspace ID without membership check.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly workspacesService: WorkspacesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: AuthUser;
      headers: Record<string, string | string[] | undefined>;
      tenant?: TenantContext;
    }>();

    const user = request.user;
    if (!user?.id) {
      throw new ForbiddenException('Authentication required');
    }

    const raw = request.headers[WORKSPACE_HEADER];
    const workspaceId = Array.isArray(raw) ? raw[0] : raw;

    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new BadRequestException(
        `Missing or invalid ${WORKSPACE_HEADER} header`,
      );
    }

    if (!Types.ObjectId.isValid(workspaceId)) {
      throw new BadRequestException('Invalid workspace ID');
    }

    const membership = await this.workspacesService.getActiveMembership(
      user.id,
      workspaceId,
    );

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    request.tenant = {
      workspaceId,
      role: membership.role,
      membershipId: String(membership._id),
    };

    return true;
  }
}
