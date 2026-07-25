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
import { BrandsService } from './brands.service';
import { TenantGuard } from '../tenancy/tenant.guard';
import { CurrentTenant } from '../tenancy/tenancy.decorators';
import type { TenantContext } from '../tenancy/tenancy.decorators';
import { WORKSPACE_HEADER } from '../common/enums';
import { CreateBrandDto, UpdateBrandFullDto } from './dto/create-brand.dto';

@ApiTags('brands')
@ApiBearerAuth()
@ApiSecurity('workspace')
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller(['brands', 'companies'])
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get()
  @ApiOperation({ summary: 'List monitored brands for the current workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.brandsService.list(tenant.workspaceId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new monitored brand (company)',
  })
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateBrandDto) {
    return this.brandsService.create(tenant.workspaceId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update monitored brand/company details or toggle enabled',
  })
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBrandFullDto,
  ) {
    return this.brandsService.update(tenant.workspaceId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a monitored brand/company' })
  delete(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.brandsService.remove(tenant.workspaceId, id);
  }
}
