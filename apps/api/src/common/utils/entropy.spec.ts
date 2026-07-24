import {
  looksLikeHighEntropySecret,
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
});
