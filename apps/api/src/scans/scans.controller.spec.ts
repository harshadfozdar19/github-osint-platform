import { BadRequestException } from '@nestjs/common';
import { ScansController } from './scans.controller';

describe('ScansController.customSearch', () => {
  const tenant = {
    workspaceId: 'ws-1',
    role: 'owner' as never,
    membershipId: 'm1',
  };

  function build(searchResult: {
    total_count: number;
    incomplete_results: boolean;
    items: Array<{ id: number }>;
  }) {
    const github = {
      searchRepositories: jest.fn().mockResolvedValue(searchResult),
      searchCode: jest.fn().mockResolvedValue(searchResult),
    };
    const seenRepos = {
      filterUnseen: jest
        .fn()
        .mockImplementation((_ws, items) =>
          Promise.resolve({ items, hiddenSeenCount: 0 }),
        ),
    };
    const controller = new ScansController(
      {} as never,
      {} as never,
      github as never,
      seenRepos as never,
    );
    return { controller, github, seenRepos };
  }

  it('appends the created qualifier to a repository search', async () => {
    const { controller, github } = build({
      total_count: 0,
      incomplete_results: false,
      items: [],
    });

    await controller.customSearch(
      tenant,
      'zerodha',
      '1',
      'repositories',
      '2026-07-31',
      '2026-08-02',
      'false',
    );

    expect(github.searchRepositories).toHaveBeenCalledWith(
      'zerodha created:2026-07-31..2026-08-02',
      1,
      10,
      { workspaceId: 'ws-1' },
    );
  });

  it('rejects a date range on code search', async () => {
    const { controller } = build({
      total_count: 0,
      incomplete_results: false,
      items: [],
    });

    await expect(
      controller.customSearch(
        tenant,
        'zerodha',
        '1',
        'code',
        '2026-07-31',
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('filters out already-seen repos by default and reports how many were hidden', async () => {
    const { controller, seenRepos } = build({
      total_count: 2,
      incomplete_results: false,
      items: [{ id: 1 }, { id: 2 }],
    });
    seenRepos.filterUnseen.mockResolvedValue({
      items: [{ id: 2 }],
      hiddenSeenCount: 1,
    });

    const result = await controller.customSearch(
      tenant,
      'zerodha',
      '1',
      'repositories',
      undefined,
      undefined,
      undefined,
    );

    expect(seenRepos.filterUnseen).toHaveBeenCalledWith(
      'ws-1',
      [{ id: 1 }, { id: 2 }],
      false,
    );
    expect(result).toEqual({
      total_count: 2,
      incomplete_results: false,
      items: [{ id: 2 }],
      hiddenSeenCount: 1,
    });
  });

  it('includes already-seen repos when includeSeen=true', async () => {
    const { controller, seenRepos } = build({
      total_count: 1,
      incomplete_results: false,
      items: [{ id: 1 }],
    });

    await controller.customSearch(
      tenant,
      'zerodha',
      '1',
      'repositories',
      undefined,
      undefined,
      'true',
    );

    expect(seenRepos.filterUnseen).toHaveBeenCalledWith(
      'ws-1',
      [{ id: 1 }],
      true,
    );
  });
});
