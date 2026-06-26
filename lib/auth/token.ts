import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const PREFIX = 'scrypt:v1';
const KEY_LEN = 32;

export const TAMTAM_AUTH_COOKIE = 'tamtam_auth';

export function generateAuthToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashAuthToken(token: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(token, salt, KEY_LEN).toString('hex');
  return `${PREFIX}:${salt}:${hash}`;
}

export function verifyAuthToken(token: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== PREFIX) return false;
  const [, , salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const actual = scryptSync(token, salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}

export function bearerToken(header: string | null): string {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}
