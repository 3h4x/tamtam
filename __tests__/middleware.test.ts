import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

describe('middleware auth gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
