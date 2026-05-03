import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getQuotaForProviderMock = vi.fn();
const clearQuotaCacheMock = vi.fn();

vi.mock('@/lib/usage/quota', () => ({
  getQuotaForProvider: getQuotaForProviderMock,
  clearQuotaCache: clearQuotaCacheMock,
}));

vi.mock('@/lib/shared/config', () => ({
  getSettings: vi.fn().mockReturnValue(null),
}));

describe('GET /api/usage/quota', () => {
  beforeEach(() => {
    vi.resetModules();
    getQuotaForProviderMock.mockReset();
    clearQuotaCacheMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns the snapshot as JSON', async () => {
    const snapshot = {
      fiveHour: { utilization: 55, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 46, resetsAt: null, msUntilReset: null },
      fetchedAt: 1,
      stale: false,
      gateEnabled: false,
    };
    getQuotaForProviderMock.mockResolvedValue(snapshot);

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(snapshot);
  });

  it('returns 502 when underlying fetcher throws', async () => {
    getQuotaForProviderMock.mockRejectedValue(new Error('No token'));

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/No token/);
  });

  it('POST clears the cache and re-fetches', async () => {
    const snapshot = {
      fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 5, resetsAt: null, msUntilReset: null },
      fetchedAt: 2,
      stale: false,
      gateEnabled: false,
    };
    getQuotaForProviderMock.mockResolvedValue(snapshot);

    const { POST } = await import('@/app/api/usage/quota/route');
    const res = await POST(new NextRequest('http://localhost/api/usage/quota', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(clearQuotaCacheMock).toHaveBeenCalled();
    expect(getQuotaForProviderMock).toHaveBeenCalledWith('active', { force: true });
    const body = await res.json();
    expect(body).toEqual(snapshot);
  });

  it('passes explicit provider query through to the quota selector', async () => {
    const snapshot = {
      provider: 'codex',
      fiveHour: { utilization: 12, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 4, resetsAt: null, msUntilReset: null },
      fetchedAt: 3,
      stale: false,
      gateEnabled: false,
    };
    getQuotaForProviderMock.mockResolvedValue(snapshot);

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota?provider=codex'));
    expect(res.status).toBe(200);
    expect(getQuotaForProviderMock).toHaveBeenCalledWith('codex');
  });
});
