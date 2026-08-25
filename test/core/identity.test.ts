import { describe, expect, it } from 'vitest';

import { matchesIdentity, normalizeEmail, normalizeIdentityPart } from '../../src/core/identity.js';

describe('identity', () => {
  it('matches either configured author field after normalization', () => {
    const identity = { name: '박성빈', email: 'SungBin@Example.com' };

    expect(matchesIdentity(identity, '박성빈', 'other@example.com')).toBe(true);
    expect(matchesIdentity(identity, 'Other', '<sungbin@example.com>')).toBe(true);
    expect(matchesIdentity(identity, 'Other', 'other@example.com')).toBe(false);
  });

  it('normalizes identity fields with compatibility normalization and lowercase', () => {
    expect(normalizeIdentityPart('  Ａlice  ')).toBe('alice');
    expect(normalizeEmail(' <ＡLICE@Example.COM> ')).toBe('alice@example.com');
  });
});
