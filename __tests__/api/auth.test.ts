import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { hashAuthToken, TAMTAM_AUTH_COOKIE } from '@/lib/auth/token';

const mocks = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
}));

vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.dbRef.current;
  },
  schema,
}));

const { GET: checkAuth } = await import('@/app/api/auth/check/route');
const { POST: login } = await import('@/app/api/auth/login/route');
const { POST: logout } = await import('@/app/api/auth/logout/route');

describe('auth API routes', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestPgDbEmpty();
    mocks.dbRef.current = handle.db;
    await handle.db.execute(sql.raw('CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL)'));
  });

  afterAll(async () => {
    await handle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await handle.db.execute(sql.raw('TRUNCATE settings'));
  });

  it('allows checks when auth is not configured', async () => {
    const res = await checkAuth(new NextRequest('http://localhost/api/auth/check'));
    await expect(res.json()).resolves.toEqual({ ok: true, configured: false });
  });

  it('accepts bearer and cookie tokens when configured', async () => {
    await handle.db.insert(schema.settings).values({ key: 'auth_token', value: hashAuthToken('secret-token-12345678901234567890') });

    const bearer = await checkAuth(new NextRequest('http://localhost/api/auth/check', {
      headers: { authorization: 'Bearer secret-token-12345678901234567890' },
    }));
    expect(bearer.status).toBe(200);

    const cookie = await checkAuth(new NextRequest('http://localhost/api/auth/check', {
      headers: { cookie: `${TAMTAM_AUTH_COOKIE}=secret-token-12345678901234567890` },
    }));
    expect(cookie.status).toBe(200);

    const missing = await checkAuth(new NextRequest('http://localhost/api/auth/check'));
    expect(missing.status).toBe(401);
  });

  it('sets and clears an httpOnly login cookie', async () => {
    await handle.db.insert(schema.settings).values({ key: 'auth_token', value: hashAuthToken('secret-token-12345678901234567890') });

    const loggedIn = await login(new NextRequest('http://localhost/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token: 'secret-token-12345678901234567890' }),
    }));
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.headers.get('set-cookie')).toContain(`${TAMTAM_AUTH_COOKIE}=secret-token`);
    expect(loggedIn.headers.get('set-cookie')).toContain('HttpOnly');

    const loggedOut = await logout();
    expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
