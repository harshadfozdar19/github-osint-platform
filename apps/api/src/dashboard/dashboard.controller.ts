import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { WORKSPACE_HEADER } from '../common/enums';

@ApiTags('dashboard')
@ApiBearerAuth()
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Dashboard overview statistics for the workspace' })
  summary(@CurrentTenant() tenant: TenantContext) {
    return this.dashboardService.summary(tenant.workspaceId);
  }
}
