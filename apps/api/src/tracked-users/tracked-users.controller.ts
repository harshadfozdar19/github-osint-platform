import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { TrackedUsersService } from './tracked-users.service';
import { AddTrackedUserDto } from './dto/add-tracked-user.dto';
import type { TrackedGithubUser } from './schemas/tracked-github-user.schema';

function withCommitSearchUrl(doc: TrackedGithubUser & { _id: unknown }) {
  return {
    ...doc,
    commitSearchUrl: TrackedUsersService.commitSearchUrl(doc.username),
  };
}

@ApiTags('tracked-users')
@ApiBearerAuth()
@ApiHeader({ name: WORKSPACE_HEADER, required: true })
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('tracked-users')
export class TrackedUsersController {
  constructor(private readonly trackedUsersService: TrackedUsersService) {}

  @Get()
  @ApiOperation({
    summary:
      "This workspace's manually curated watchlist of GitHub usernames - each with a ready-made link to GitHub's own commit search for that author (newest first), for tracking what someone has actually committed without this app ever calling GitHub's API itself",
  })
  async list(@CurrentTenant() tenant: TenantContext) {
    const rows = await this.trackedUsersService.list(tenant.workspaceId);
    return rows.map((r) => withCommitSearchUrl(r));
  }

  @Post()
  @ApiOperation({ summary: 'Track a GitHub username' })
  async add(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: AddTrackedUserDto,
  ) {
    const created = await this.trackedUsersService.add(
      tenant.workspaceId,
      dto.username,
      dto.note,
    );
    return withCommitSearchUrl(created.toObject());
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop tracking a username' })
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
  ): Promise<void> {
    await this.trackedUsersService.remove(tenant.workspaceId, id);
  }
}
