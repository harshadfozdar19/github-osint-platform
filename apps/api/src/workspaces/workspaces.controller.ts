import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/current-user.decorator';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto, SetGithubTokenDto } from './dto/workspace.dto';
import { GitHubService } from '../github/github.service';
import { isGitHubClientError } from '../github/github.errors';

@ApiTags('workspaces')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspacesController {
  private readonly logger = new Logger(WorkspacesController.name);

  constructor(
    private readonly workspacesService: WorkspacesService,
    private readonly githubService: GitHubService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a workspace (caller becomes owner)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.createForUser(user.id, dto.name);
  }

  @Get()
  @ApiOperation({ summary: 'List workspaces for the current user' })
  list(@CurrentUser() user: AuthUser): Promise<Array<Record<string, unknown>>> {
    return this.workspacesService.listForUser(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a workspace if the user is a member' })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    return this.workspacesService.getWorkspaceForMember(user.id, id);
  }

  @Post(':id/switch')
  @ApiOperation({
    summary:
      'Validate membership and return workspace context for client-side switching',
  })
  switchTo(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    return this.workspacesService.getWorkspaceForMember(user.id, id);
  }

  @Get(':id/github-token')
  @ApiOperation({
    summary:
      'Masked GitHub token status (configured + last 4 chars only, never the token itself)',
  })
  getGithubTokenStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.workspacesService.getGithubTokenStatus(user.id, id);
  }

  @Patch(':id/github-token')
  @ApiOperation({
    summary:
      "Set or replace this workspace's own GitHub token. Encrypted at rest; scans use it instead of the shared GITHUB_TOKEN. Verified against GitHub immediately so the quota panel has real data right away and an invalid token is rejected up front.",
  })
  async setGithubToken(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetGithubTokenDto,
  ) {
    const result = await this.workspacesService.setGithubToken(
      user.id,
      id,
      dto.token,
    );
    try {
      await this.githubService.refreshRateLimitStatus(id);
    } catch (error) {
      if (isGitHubClientError(error) && error.code === 'AUTH') {
        await this.workspacesService.clearGithubToken(user.id, id);
        throw new BadRequestException(
          'GitHub rejected that token (invalid, expired, or revoked) — it has not been saved. Double-check the token and try again.',
        );
      }
      // Any other failure (network hiccup, transient rate limit, etc.) is not
      // proof the token is bad - keep it saved and let quota populate from
      // the next real scan instead of blocking the save on this check.
      this.logger.warn(
        `Rate-limit verification failed for workspace ${id} after saving token: ${(error as Error).message}`,
      );
    }
    return result;
  }

  @Delete(':id/github-token')
  @ApiOperation({
    summary:
      "Remove this workspace's own GitHub token; falls back to the shared GITHUB_TOKEN if configured.",
  })
  clearGithubToken(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.workspacesService.clearGithubToken(user.id, id);
  }
}
