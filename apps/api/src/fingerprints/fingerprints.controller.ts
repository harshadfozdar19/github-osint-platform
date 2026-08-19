import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { WORKSPACE_HEADER } from '../common/enums';
import { ReferenceFingerprintService } from './reference-fingerprint.service';
import { AddReferenceRepoDto } from './dto/add-reference-repo.dto';

@ApiTags('fingerprints')
@ApiBearerAuth()
@ApiSecurity('workspace')
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('brands/:brandId/reference-repos')
export class FingerprintsController {
  constructor(
    private readonly referenceFingerprintService: ReferenceFingerprintService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "List a brand's ingested reference repos (its own codebase, used as the external-audit comparison baseline)",
  })
  list(
    @CurrentTenant() tenant: TenantContext,
    @Param('brandId') brandId: string,
  ) {
    return this.referenceFingerprintService.listReferenceRepos(
      tenant.workspaceId,
      brandId,
    );
  }

  @Post()
  @ApiOperation({
    summary:
      "Clone and fingerprint one of the brand's own repos as a reference baseline",
  })
  ingest(
    @CurrentTenant() tenant: TenantContext,
    @Param('brandId') brandId: string,
    @Body() dto: AddReferenceRepoDto,
  ) {
    return this.referenceFingerprintService.ingestReferenceRepo(
      tenant.workspaceId,
      brandId,
      dto.owner,
      dto.repo,
    );
  }

  @Delete(':owner/:repo')
  @ApiOperation({
    summary: 'Remove a reference repo and its fingerprints from the baseline',
  })
  remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('brandId') brandId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ) {
    return this.referenceFingerprintService.removeReferenceRepo(
      tenant.workspaceId,
      brandId,
      owner,
      repo,
    );
  }
}
