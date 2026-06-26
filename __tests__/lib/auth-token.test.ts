import { describe, expect, it } from 'vitest';
import { bearerToken, generateAuthToken, hashAuthToken, verifyAuthToken } from '@/lib/auth/token';

describe('auth token helpers', () => {
  it('hashes and verifies shared tokens without storing the plaintext', () => {
    const token = generateAuthToken();
    const hash = hashAuthToken(token);

    expect(hash).toMatch(/^scrypt:v1:/);
    expect(hash).not.toContain(token);
    expect(verifyAuthToken(token, hash)).toBe(true);
    expect(verifyAuthToken(`${token}x`, hash)).toBe(false);
  });

  it('parses bearer headers', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('Basic abc123')).toBe('');
    expect(bearerToken(null)).toBe('');
  });
});
