import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { WORKSPACE_HEADER } from '../common/enums';
import { IntelligenceService } from './intelligence.service';

@ApiTags('intelligence')
@ApiBearerAuth()
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('intelligence')
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  @Get('assessments/repository/:repositoryId')
  @ApiOperation({
    summary: 'Latest AI intent/risk assessment for a repository, if any',
  })
  async latestForRepository(
    @CurrentTenant() tenant: TenantContext,
    @Param('repositoryId') repositoryId: string,
  ) {
    const assessment = await this.intelligence.latestForRepository(
      tenant.workspaceId,
      repositoryId,
    );
    if (!assessment)
      throw new NotFoundException('No assessment for this repository yet');
    return assessment;
  }

  @Post('assessments/repository/:repositoryId/reanalyze')
  @ApiOperation({
    summary:
      'Request a fresh AI assessment for a repository - safe to call repeatedly, a no-op LLM-call-wise if nothing relevant has changed since the last assessment',
  })
  async reanalyze(
    @CurrentTenant() tenant: TenantContext,
    @Param('repositoryId') repositoryId: string,
  ) {
    const assessment = await this.intelligence.reanalyze(
      tenant.workspaceId,
      repositoryId,
    );
    if (!assessment)
      throw new NotFoundException(
        'No finding to assess for this repository, or no AI provider is configured',
      );
    return assessment;
  }

  @Patch('assessments/:id/agreement')
  @ApiOperation({
    summary:
      'Record analyst agreement/disagreement with an assessment - the true/false feedback signal',
  })
  async recordAgreement(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: { agreement?: 'agree' | 'disagree' },
  ) {
    if (body.agreement !== 'agree' && body.agreement !== 'disagree') {
      throw new BadRequestException('agreement must be "agree" or "disagree"');
    }
    const updated = await this.intelligence.recordAgreement(
      tenant.workspaceId,
      id,
      body.agreement,
    );
    if (!updated) throw new NotFoundException('Assessment not found');
    return updated;
  }

  @Get('stats')
  @ApiOperation({
    summary:
      'Assessment counts by tier/status/provider for this workspace - Tier-1 vs deep-review volume, failure rate',
  })
  stats(@CurrentTenant() tenant: TenantContext) {
    return this.intelligence.stats(tenant.workspaceId);
  }
}
