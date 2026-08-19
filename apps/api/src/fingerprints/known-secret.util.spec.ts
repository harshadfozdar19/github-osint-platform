import { createHash } from 'crypto';
import { extractSecretValueHashes } from './known-secret.util';

describe('extractSecretValueHashes', () => {
  it('returns [] for content with no secrets', () => {
    expect(extractSecretValueHashes('const x = 1;\nconsole.log(x);')).toEqual(
      [],
    );
  });

  it('detects an AWS access key and returns only its hash, never the raw value', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const results = extractSecretValueHashes(`AWS_ACCESS_KEY_ID=${key}`);
    expect(results).toHaveLength(1);
    expect(results[0].patternId).toBe('secret-aws-access-key');
    expect(results[0].valueHash).toBe(
      createHash('sha256').update(key, 'utf8').digest('hex'),
    );
    expect(results[0].valueHash).not.toContain(key);
    expect(JSON.stringify(results)).not.toContain(key);
  });

  it('produces a deterministic hash for the same value', () => {
    const content = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    expect(extractSecretValueHashes(content)).toEqual(
      extractSecretValueHashes(content),
    );
  });

  it('produces different hashes for different values of the same secret type', () => {
    const a = extractSecretValueHashes('AKIAIOSFODNN7EXAMPLE');
    const b = extractSecretValueHashes('AKIAJJJJJJJJJJJJJJJJ');
    expect(a[0].valueHash).not.toBe(b[0].valueHash);
  });

  it('detects multiple distinct secret types in the same content', () => {
    const content = [
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    ].join('\n');
    const results = extractSecretValueHashes(content);
    const patternIds = results.map((r) => r.patternId).sort();
    expect(patternIds).toEqual(['secret-aws-access-key', 'secret-github-pat']);
  });

  it('deduplicates the same value repeated in content', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const results = extractSecretValueHashes(`${key}\n${key}\n${key}`);
    expect(results).toHaveLength(1);
  });

  it('returns a 64-char hex sha256 digest', () => {
    const results = extractSecretValueHashes('AKIAIOSFODNN7EXAMPLE');
    expect(results[0].valueHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
