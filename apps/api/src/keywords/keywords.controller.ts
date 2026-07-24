import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
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
import { KeywordsService } from './keywords.service';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { WORKSPACE_HEADER } from '../common/enums';
import { CreateKeywordDto, UpdateKeywordDto } from './dto/create-keyword.dto';

@ApiTags('keywords')
@ApiBearerAuth()
@ApiSecurity('workspace')
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('keywords')
export class KeywordsController {
  constructor(private readonly keywordsService: KeywordsService) {}

  @Get()
  @ApiOperation({ summary: 'List keywords for the current workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.keywordsService.list(tenant.workspaceId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new keyword' })
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateKeywordDto,
  ) {
    return this.keywordsService.create(tenant.workspaceId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update/Enable/Disable a keyword' })
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateKeywordDto,
  ) {
    return this.keywordsService.update(tenant.workspaceId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a keyword' })
  delete(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.keywordsService.remove(tenant.workspaceId, id);
  }
}
