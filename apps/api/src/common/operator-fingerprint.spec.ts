import { extractOperatorFingerprints } from './operator-fingerprint';

describe('extractOperatorFingerprints', () => {
  it('extracts a real contact email and ignores placeholder ones', () => {
    const result = extractOperatorFingerprints({
      readmeText:
        'Contact us at scammer.support@protonmail.com or you@example.com for help.',
      smallFileTexts: [],
    });
    expect(result).toContainEqual({
      kind: 'email',
      value: 'scammer.support@protonmail.com',
    });
    expect(result.some((f) => f.value === 'you@example.com')).toBe(false);
  });

  it('extracts a telegram contact link', () => {
    const result = extractOperatorFingerprints({
      readmeText: 'DM me on Telegram: https://t.me/walletrecovery_help',
      smallFileTexts: [],
    });
    expect(result).toContainEqual({
      kind: 'telegram',
      value: 'walletrecovery_help',
    });
  });

  it('extracts a whatsapp contact link', () => {
    const result = extractOperatorFingerprints({
      readmeText: 'Support: https://wa.me/919876543210',
      smallFileTexts: [],
    });
    expect(result).toContainEqual({ kind: 'whatsapp', value: '919876543210' });
  });

  it('extracts a discord invite', () => {
    const result = extractOperatorFingerprints({
      readmeText: 'Join our discord.gg/scamserver1',
      smallFileTexts: [],
    });
    expect(result).toContainEqual({
      kind: 'discord_invite',
      value: 'scamserver1',
    });
  });

  it('extracts an ETH wallet address', () => {
    const address = '0x' + 'a1b2c3d4e5f6'.repeat(3) + 'a1b2';
    const result = extractOperatorFingerprints({
      readmeText: `Send fee to unlock your wallet: ${address}`,
      smallFileTexts: [],
    });
    expect(result).toContainEqual({ kind: 'crypto_wallet', value: address });
  });

  it('extracts a BTC wallet address', () => {
    const result = extractOperatorFingerprints({
      readmeText:
        'BTC: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa is our recovery fee address',
      smallFileTexts: [],
    });
    expect(result).toContainEqual({
      kind: 'crypto_wallet',
      value: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    });
  });

  it('reads from smallFileTexts as well as readmeText', () => {
    const result = extractOperatorFingerprints({
      readmeText: '',
      smallFileTexts: [
        { path: 'contact.txt', content: 'reach us: real.contact@gmail.com' },
      ],
    });
    expect(result).toContainEqual({
      kind: 'email',
      value: 'real.contact@gmail.com',
    });
  });

  it('de-duplicates the same fingerprint appearing multiple times', () => {
    const result = extractOperatorFingerprints({
      readmeText: 'Contact scam@gmail.com or email scam@gmail.com again.',
      smallFileTexts: [],
    });
    expect(result.filter((f) => f.value === 'scam@gmail.com')).toHaveLength(1);
  });

  it('returns an empty array when there is no identity-revealing content', () => {
    const result = extractOperatorFingerprints({
      readmeText: 'A perfectly normal open source utility library.',
      smallFileTexts: [],
    });
    expect(result).toEqual([]);
  });
});
