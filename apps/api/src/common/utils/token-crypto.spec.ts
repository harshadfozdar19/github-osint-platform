import { decryptSecret, encryptSecret, maskToken } from './token-crypto';

describe('token-crypto', () => {
  const masterKey = 'test-master-key-not-a-real-secret-32bytes';

  it('round-trips a plaintext token through encrypt/decrypt', () => {
    const token = 'ghp_realtokenvalue0000000000000000000001';
    const encrypted = encryptSecret(token, masterKey);
    expect(encrypted.ciphertext).not.toContain(token);
    expect(decryptSecret(encrypted, masterKey)).toBe(token);
  });

  it('produces a different IV/ciphertext each time (no reuse)', () => {
    const token = 'ghp_realtokenvalue0000000000000000000001';
    const a = encryptSecret(token, masterKey);
    const b = encryptSecret(token, masterKey);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails to decrypt with the wrong key', () => {
    const token = 'ghp_realtokenvalue0000000000000000000001';
    const encrypted = encryptSecret(token, masterKey);
    expect(() =>
      decryptSecret(encrypted, 'a-completely-different-key'),
    ).toThrow();
  });

  it('detects tampering with the ciphertext (auth tag mismatch)', () => {
    const token = 'ghp_realtokenvalue0000000000000000000001';
    const encrypted = encryptSecret(token, masterKey);
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.replace(/^../, '00'),
    };
    expect(() => decryptSecret(tampered, masterKey)).toThrow();
  });

  it('masks down to the last 4 characters only', () => {
    expect(maskToken('ghp_realtokenvalue0000000000000000000001')).toBe('0001');
    expect(maskToken('abc')).toBe('****');
  });
});
