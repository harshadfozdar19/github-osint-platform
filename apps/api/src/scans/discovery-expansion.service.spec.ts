import { Types } from 'mongoose';
import { DiscoveryExpansionService } from './discovery-expansion.service';

describe('DiscoveryExpansionService.promoteKeywordsFromFinding', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  function buildService(
    existingKeywords: string[],
    configOverrides: Record<string, string> = {},
  ) {
    const inserted: Array<Record<string, unknown>> = [];
    const keywordModel = {
      find: jest.fn().mockReturnValue({
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve(existingKeywords.map((keyword) => ({ keyword }))),
          }),
        }),
      }),
      updateOne: jest.fn(
        (
          query: { keyword: string },
          update: { $setOnInsert: Record<string, unknown> },
        ) => {
          if (existingKeywords.includes(query.keyword)) {
            return Promise.resolve({ upsertedCount: 0 });
          }
          inserted.push(update.$setOnInsert);
          return Promise.resolve({ upsertedCount: 1 });
        },
      ),
    };
    const config = { get: (key: string) => configOverrides[key] };

    const service = new DiscoveryExpansionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config as never,
      {} as never,
      {} as never,
      keywordModel as never,
    );
    return { service, inserted, keywordModel };
  }

  it('auto-promotes a curated keyword found in the repo blob that is not yet enabled', async () => {
    const { service, inserted } = buildService(['phishing']);
    const promoted = await service.promoteKeywordsFromFinding(
      workspaceId,
      'evil/phonepe-otp-bypass PhonePe OTP bypass login clone kit',
    );
    expect(promoted).toBeGreaterThan(0);
    expect(inserted.some((k) => k.keyword === 'otp')).toBe(true);
    expect(inserted.every((k) => k.source === 'auto')).toBe(true);
  });

  it('does not re-promote a keyword the workspace already has', async () => {
    const { service, inserted } = buildService([
      'otp',
      'bypass',
      'login',
      'clone',
    ]);
    const promoted = await service.promoteKeywordsFromFinding(
      workspaceId,
      'evil/phonepe-otp-bypass PhonePe OTP bypass login clone kit',
    );
    expect(promoted).toBe(0);
    expect(inserted.length).toBe(0);
  });

  it('does nothing when AUTO_PROMOTE_KEYWORDS is disabled', async () => {
    const { service, inserted } = buildService([], {
      AUTO_PROMOTE_KEYWORDS: 'false',
    });
    const promoted = await service.promoteKeywordsFromFinding(
      workspaceId,
      'evil/phonepe-otp-bypass PhonePe OTP bypass login clone kit',
    );
    expect(promoted).toBe(0);
    expect(inserted.length).toBe(0);
  });
});
