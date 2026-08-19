const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

import { CredentialVerificationService } from './credential-verification.service';

describe('CredentialVerificationService', () => {
  let service: CredentialVerificationService;

  beforeEach(() => {
    service = new CredentialVerificationService();
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('reports an active GitHub token when GitHub returns 200', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { login: 'octocat' } });
    const result = await service.verify('secret-github-pat', 'ghp_fake');
    expect(result.status).toBe('active');
    expect(result.detail).toContain('octocat');
    expect(mockGet).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: { Authorization: 'token ghp_fake' },
      }),
    );
  });

  it('reports an invalid GitHub token when GitHub returns 401', async () => {
    mockGet.mockResolvedValue({ status: 401, data: {} });
    const result = await service.verify('secret-github-pat', 'ghp_fake');
    expect(result.status).toBe('invalid');
  });

  it('reports active Stripe key on 200', async () => {
    mockGet.mockResolvedValue({ status: 200, data: {} });
    const result = await service.verify('secret-stripe-live', 'sk_live_fake');
    expect(result.status).toBe('active');
  });

  it('reports invalid Stripe key on 401', async () => {
    mockGet.mockResolvedValue({ status: 401, data: {} });
    const result = await service.verify('secret-stripe-live', 'sk_live_fake');
    expect(result.status).toBe('invalid');
  });

  it('reports active Slack token when auth.test returns ok:true', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { ok: true } });
    const result = await service.verify('secret-slack-token', 'xoxb-fake');
    expect(result.status).toBe('active');
  });

  it('reports invalid Slack token when auth.test returns ok:false', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: { ok: false, error: 'invalid_auth' },
    });
    const result = await service.verify('secret-slack-token', 'xoxb-fake');
    expect(result.status).toBe('invalid');
    expect(result.detail).toContain('invalid_auth');
  });

  it('reports a network error as status "error", not "invalid"', async () => {
    mockGet.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await service.verify('secret-github-pat', 'ghp_fake');
    expect(result.status).toBe('error');
  });

  it('marks AWS access keys unsupported (needs paired secret key)', async () => {
    const result = await service.verify('secret-aws-access-key', 'AKIAFAKE');
    expect(result.status).toBe('unsupported');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('marks database connection strings unsupported (would require a live DB connection)', async () => {
    const mongo = await service.verify('secret-mongodb-uri', 'mongodb://x');
    const redis = await service.verify('secret-redis-uri', 'redis://x');
    const postgres = await service.verify(
      'secret-postgres-uri',
      'postgres://x',
    );
    const mysql = await service.verify('secret-mysql-uri', 'mysql://x');
    for (const r of [mongo, redis, postgres, mysql]) {
      expect(r.status).toBe('unsupported');
    }
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('marks generic/JWT/certificate-style patterns unsupported by default', async () => {
    const result = await service.verify('secret-jwt', 'eyJfake');
    expect(result.status).toBe('unsupported');
  });

  it('reports active Discord webhook on 200 and invalid on 404', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, data: {} });
    const active = await service.verify(
      'secret-discord-webhook',
      'https://discord.com/api/webhooks/123/abc',
    );
    expect(active.status).toBe('active');

    mockGet.mockResolvedValueOnce({ status: 404, data: {} });
    const invalid = await service.verify(
      'secret-discord-webhook',
      'https://discord.com/api/webhooks/123/abc',
    );
    expect(invalid.status).toBe('invalid');
  });

  it('reports active Telegram bot token when getMe returns ok:true', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { ok: true } });
    const result = await service.verify('secret-telegram-token', '123:fake');
    expect(result.status).toBe('active');
  });
});
