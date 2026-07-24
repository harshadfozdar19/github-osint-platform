import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { WorkspaceRole } from '../common/enums';

export interface TenantContext {
  workspaceId: string;
  role: WorkspaceRole;
  membershipId: string;
}

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<{ tenant: TenantContext }>();
    return request.tenant;
  },
);
