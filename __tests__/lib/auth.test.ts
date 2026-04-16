import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { checkAuth } from '@/lib/auth';

afterEach(() => {
  delete process.env.Z_API_TOKEN;
});

describe('checkAuth', () => {
  it('returns null when Z_API_TOKEN is not set', () => {
    const request = new NextRequest('http://localhost/api/test');
    const result = checkAuth(request);
    expect(result).toBeNull();
  });

  it('returns 401 when Z_API_TOKEN is set but no Authorization header', () => {
    process.env.Z_API_TOKEN = 'secret';
    const request = new NextRequest('http://localhost/api/test');
    const result = checkAuth(request);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 when Authorization header is not Bearer', () => {
    process.env.Z_API_TOKEN = 'secret';
    const request = new NextRequest('http://localhost/api/test', {
      headers: { Authorization: 'Basic secret' },
    });
    const result = checkAuth(request);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 when token is wrong', () => {
    process.env.Z_API_TOKEN = 'secret';
    const request = new NextRequest('http://localhost/api/test', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const result = checkAuth(request);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns null when token is correct', () => {
    process.env.Z_API_TOKEN = 'secret';
    const request = new NextRequest('http://localhost/api/test', {
      headers: { Authorization: 'Bearer secret' },
    });
    const result = checkAuth(request);
    expect(result).toBeNull();
  });

  it('returns detail message for missing header', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const request = new NextRequest('http://localhost/api/test');
    const result = checkAuth(request);
    const data = await result!.json();
    expect(data.detail).toContain('Authorization');
  });

  it('returns detail message for invalid token', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const request = new NextRequest('http://localhost/api/test', {
      headers: { Authorization: 'Bearer bad' },
    });
    const result = checkAuth(request);
    const data = await result!.json();
    expect(data.detail).toBeTruthy();
  });
});
