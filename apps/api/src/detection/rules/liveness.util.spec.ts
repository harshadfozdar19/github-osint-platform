jest.mock('dns/promises', () => ({ lookup: jest.fn() }));

import { lookup } from 'dns/promises';
import { checkUrlLiveness } from './liveness.util';

const mockLookup = lookup as jest.Mock;

function mockFetchOnce(impl: () => unknown) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(impl as never);
}

describe('checkUrlLiveness', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns null for an invalid URL', async () => {
    await expect(checkUrlLiveness('not a url')).resolves.toBeNull();
  });

  it('returns null for a non-http(s) protocol', async () => {
    await expect(checkUrlLiveness('ftp://example.com')).resolves.toBeNull();
  });

  it('never fetches when the hostname resolves to a private IP (SSRF guard)', async () => {
    mockLookup.mockResolvedValue({ address: '10.0.0.5' });
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchSpy;
    const result = await checkUrlLiveness('http://internal.example.com/x');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never resolves localhost at all', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchSpy;
    const result = await checkUrlLiveness('http://localhost:3000/x');
    expect(result).toBeNull();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns live:true for a public host that responds with 200', async () => {
    mockLookup.mockResolvedValue({ address: '93.184.216.34' });
    mockFetchOnce(async () => ({
      status: 200,
      body: { cancel: async () => undefined },
    }));
    const result = await checkUrlLiveness('https://example.com/login');
    expect(result).toEqual({
      url: 'https://example.com/login',
      live: true,
      statusCode: 200,
    });
  });

  it('treats a 5xx response as not live', async () => {
    mockLookup.mockResolvedValue({ address: '93.184.216.34' });
    mockFetchOnce(async () => ({
      status: 503,
      body: { cancel: async () => undefined },
    }));
    const result = await checkUrlLiveness('https://example.com/x');
    expect(result?.live).toBe(false);
  });

  it('returns null when DNS lookup fails', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await checkUrlLiveness(
      'https://nonexistent.example.invalid',
    );
    expect(result).toBeNull();
  });

  it('returns null when the fetch itself throws (timeout, network error)', async () => {
    mockLookup.mockResolvedValue({ address: '93.184.216.34' });
    mockFetchOnce(async () => {
      throw new Error('aborted');
    });
    const result = await checkUrlLiveness('https://example.com/x');
    expect(result).toBeNull();
  });
});
