import { BadRequestException } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { GitHubClientError } from '../github/github.errors';

describe('WorkspacesController.setGithubToken', () => {
  const user = { id: 'user-1' } as never;

  function build(overrides?: { refreshError?: unknown }) {
    const workspacesService = {
      setGithubToken: jest.fn().mockResolvedValue({ configured: true }),
      clearGithubToken: jest.fn().mockResolvedValue({ configured: false }),
    };
    const githubService = {
      refreshRateLimitStatus: overrides?.refreshError
        ? jest.fn().mockRejectedValue(overrides.refreshError)
        : jest.fn().mockResolvedValue(undefined),
    };
    const controller = new WorkspacesController(
      workspacesService as never,
      githubService as never,
    );
    return { controller, workspacesService, githubService };
  }

  it('saves the token and verifies it against GitHub on success', async () => {
    const { controller, workspacesService, githubService } = build();

    const result = await controller.setGithubToken(user, 'ws-1', {
      token: 'ghp_validtoken',
    });

    expect(workspacesService.setGithubToken).toHaveBeenCalledWith(
      'user-1',
      'ws-1',
      'ghp_validtoken',
    );
    expect(githubService.refreshRateLimitStatus).toHaveBeenCalledWith('ws-1');
    expect(workspacesService.clearGithubToken).not.toHaveBeenCalled();
    expect(result).toEqual({ configured: true });
  });

  it('rolls back and rejects when GitHub says the token is invalid', async () => {
    const { controller, workspacesService } = build({
      refreshError: new GitHubClientError('bad creds', 'AUTH', 401),
    });

    await expect(
      controller.setGithubToken(user, 'ws-1', {
        token: 'ghp_badtoken',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(workspacesService.clearGithubToken).toHaveBeenCalledWith(
      'user-1',
      'ws-1',
    );
  });

  it('keeps the token saved when verification fails for a non-auth reason', async () => {
    const { controller, workspacesService } = build({
      refreshError: new GitHubClientError('network blip', 'NETWORK'),
    });

    const result = await controller.setGithubToken(user, 'ws-1', {
      token: 'ghp_validtoken',
    });

    expect(workspacesService.clearGithubToken).not.toHaveBeenCalled();
    expect(result).toEqual({ configured: true });
  });
});
