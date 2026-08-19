import {
  looksLikeCodeReference,
  looksLikeHighEntropySecret,
  looksLikePlaceholderValue,
  shannonEntropy,
} from '../../common/utils/entropy';

describe('entropy helpers', () => {
  it('scores random-looking tokens higher than repeated chars', () => {
    expect(shannonEntropy('aaaaaaaaaaaaaaaaaaaa')).toBeLessThan(1);
    expect(shannonEntropy('K7mQ2xP9vL4nR8wY3tZ1')).toBeGreaterThan(3);
  });

  it('rejects placeholders and accepts high-entropy assignments', () => {
    expect(looksLikeHighEntropySecret('changeme_password_here_ok')).toBe(false);
    expect(looksLikeHighEntropySecret('xk29QmP7vL4nR8wY3tZ1aB6cD')).toBe(true);
  });

  it('rejects a Docker/k8s-style "change this in production" default value', () => {
    expect(
      looksLikeHighEntropySecret('dev-secret-key-change-in-production'),
    ).toBe(false);
    expect(looksLikeHighEntropySecret('please-changeme-before-deploy')).toBe(
      false,
    );
  });

  it('rejects a code identifier/attribute reference, not a literal value', () => {
    expect(looksLikeHighEntropySecret('settings.openai_api_key')).toBe(false);
    expect(looksLikeHighEntropySecret('process.env.OPENAI_API_KEY')).toBe(
      false,
    );
  });

  it('still accepts a real high-entropy value that merely contains a dot', () => {
    // A base64-flavored real secret can legitimately contain a dot, but it
    // won't be shaped like a chain of readable identifier segments.
    expect(
      looksLikeHighEntropySecret('xK29.QmP7vL4nR8wY3tZ1aB6cD9fG2hJ5'),
    ).toBe(true);
  });

  it('rejects a camelCase/PascalCase JS/TS property reference, not a literal value', () => {
    // regression: config.secretAccessKey / resp.continuationToken were being
    // flagged as leaked secrets - they're just code reading/passing along a
    // credential defined elsewhere, the same as the snake_case case above.
    expect(looksLikeHighEntropySecret('config.secretAccessKey')).toBe(false);
    expect(looksLikeHighEntropySecret('resp.nextContinuationToken')).toBe(
      false,
    );
    expect(looksLikeHighEntropySecret('this.userAccessToken')).toBe(false);
  });
});

describe('looksLikePlaceholderValue', () => {
  it('flags obvious example/placeholder values regardless of length', () => {
    expect(looksLikePlaceholderValue('your_api_key')).toBe(true);
    expect(looksLikePlaceholderValue('sampleAccessToken')).toBe(true);
    expect(looksLikePlaceholderValue('changeme')).toBe(true);
    expect(looksLikePlaceholderValue('dev-secret-key-change-in-production')).toBe(
      true,
    );
  });

  it('does not flag a real-looking secret value', () => {
    expect(looksLikePlaceholderValue('zK9mQ2xP7vL4nR8wY3tZ1aB6cD5eF')).toBe(
      false,
    );
    expect(looksLikePlaceholderValue('AKIAIOSFODNN7EXAMPLE')).toBe(false);
  });
});

describe('looksLikeCodeReference', () => {
  it('recognizes dotted attribute/variable references', () => {
    expect(looksLikeCodeReference('settings.openai_api_key')).toBe(true);
    expect(looksLikeCodeReference('process.env.API_KEY')).toBe(true);
    expect(looksLikeCodeReference('self.config.api_token')).toBe(true);
  });

  it('does not flag a bare token or a real-looking secret value', () => {
    expect(looksLikeCodeReference('sk-proj-abc123XYZ')).toBe(false);
    expect(looksLikeCodeReference('xK29QmP7vL4nR8wY3tZ1')).toBe(false);
    expect(looksLikeCodeReference('AKIAABCDEFGHIJKLMNOP')).toBe(false);
  });

  it('recognizes camelCase/PascalCase dotted property access (JS/TS convention)', () => {
    expect(looksLikeCodeReference('config.secretAccessKey')).toBe(true);
    expect(looksLikeCodeReference('resp.nextContinuationToken')).toBe(true);
    expect(looksLikeCodeReference('this.userAccessToken')).toBe(true);
  });

  it('still rejects a dotted value whose segments contain digits (not a clean identifier)', () => {
    // A segment with a digit in it (xK29) never counts as a camelCase
    // identifier here - that's what keeps a real base64/JWT-flavored secret
    // that happens to contain a dot from slipping through as a "reference".
    expect(looksLikeCodeReference('xK29.QmP7vL4nR8wY3tZ1aB6cD9fG2hJ5')).toBe(
      false,
    );
  });
});
