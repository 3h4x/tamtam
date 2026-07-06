import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, _resetAuthCacheForTests } from '@/middleware';

describe('middleware auth gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetAuthCacheForTests();
  });

  it('allows public health without checking auth', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await middleware(new NextRequest('http://localhost/api/health'));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects API calls when auth check fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const res = await middleware(new NextRequest('http://localhost/api/projects/by-project/app/run'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ detail: 'Unauthorized' });
  });

  it('allows API calls when auth check succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const res = await middleware(new NextRequest('http://localhost/api/settings', {
      headers: { authorization: 'Bearer token' },
    }));
    expect(res.status).toBe(200);
  });

  it('redirects browser pages to login when auth check fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const res = await middleware(new NextRequest('http://localhost/settings/general'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/login?next=%2Fsettings%2Fgeneral');
  });

  it('single-flights concurrent identical checks into one fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const mk = () => new NextRequest('http://localhost/api/settings', { headers: { authorization: 'Bearer t' } });
    const [a, b, c] = await Promise.all([middleware(mk()), middleware(mk()), middleware(mk())]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    // 3 concurrent requests with identical creds → exactly one auth check.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached decision for a repeat request within TTL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const mk = () => new NextRequest('http://localhost/api/settings', { headers: { authorization: 'Bearer t2' } });
    expect((await middleware(mk())).status).toBe(200);
    expect((await middleware(mk())).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('checks separately for different credentials', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    await middleware(new NextRequest('http://localhost/api/settings', { headers: { authorization: 'Bearer A' } }));
    await middleware(new NextRequest('http://localhost/api/settings', { headers: { authorization: 'Bearer B' } }));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not cache a transient fetch error (next request retries)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const mk = () => new NextRequest('http://localhost/api/settings', { headers: { authorization: 'Bearer t3' } });
    // First: fetch errors → denied (401), and the failure must NOT be cached.
    expect((await middleware(mk())).status).toBe(401);
    // Second: retries the check, now succeeds.
    expect((await middleware(mk())).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
