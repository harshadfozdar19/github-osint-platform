import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function formatCategory(category) {
  return category.replace(/_/g, ' ');
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildFindingsQuery(params) {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.severity) q.set('severity', params.severity);
  q.set('page', String(params.page || 1));
  return q.toString();
}

describe('format utilities', () => {
  it('formats categories', () => {
    assert.equal(formatCategory('exposed_secret'), 'exposed secret');
  });

  it('clamps scores', () => {
    assert.equal(clampScore(150), 100);
    assert.equal(clampScore(-5), 0);
  });

  it('builds query strings', () => {
    assert.match(buildFindingsQuery({ search: 'phonepe', severity: 'high', page: 2 }), /search=phonepe/);
  });
});
