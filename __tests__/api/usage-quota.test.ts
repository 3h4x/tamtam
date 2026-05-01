import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getClaudeQuotaMock = vi.fn();
const clearQuotaCacheMock = vi.fn();

vi.mock('@/lib/usage/claude-quota', () => ({
  getClaudeQuota: getClaudeQuotaMock,
  clearQuotaCache: clearQuotaCacheMock,
}));

describe('GET /api/usage/quota', () => {
  beforeEach(() => {
    vi.resetModules();
    getClaudeQuotaMock.mockReset();
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
    };
    getClaudeQuotaMock.mockResolvedValue(snapshot);

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(snapshot);
  });

  it('returns 502 when underlying fetcher throws', async () => {
    getClaudeQuotaMock.mockRejectedValue(new Error('No token'));

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET();
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
    };
    getClaudeQuotaMock.mockResolvedValue(snapshot);

    const { POST } = await import('@/app/api/usage/quota/route');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(clearQuotaCacheMock).toHaveBeenCalled();
    expect(getClaudeQuotaMock).toHaveBeenCalledWith({ force: true });
    const body = await res.json();
    expect(body).toEqual(snapshot);
  });
});
