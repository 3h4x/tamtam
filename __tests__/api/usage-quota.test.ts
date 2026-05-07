import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getQuotaForProviderMock = vi.fn();
const clearQuotaCacheMock = vi.fn();
const scheduledBurnRateBlockedAcrossProvidersMock = vi.fn().mockReturnValue(null);
const warmEnabledProviderSnapshotsMock = vi.fn().mockResolvedValue(undefined);
const getSettingsMock = vi.fn().mockReturnValue(null);

vi.mock('@/lib/usage/quota', () => ({
  getQuotaForProvider: getQuotaForProviderMock,
  clearQuotaCache: clearQuotaCacheMock,
}));

vi.mock('@/lib/shared/job-control', () => ({
  scheduledBurnRateBlockedAcrossProviders: scheduledBurnRateBlockedAcrossProvidersMock,
  warmEnabledProviderSnapshots: warmEnabledProviderSnapshotsMock,
}));

vi.mock('@/lib/shared/config', () => ({
  getSettings: getSettingsMock,
}));

describe('GET /api/usage/quota', () => {
  beforeEach(() => {
    vi.resetModules();
    getQuotaForProviderMock.mockReset();
    clearQuotaCacheMock.mockReset();
    scheduledBurnRateBlockedAcrossProvidersMock.mockReset();
    scheduledBurnRateBlockedAcrossProvidersMock.mockReturnValue(null);
    warmEnabledProviderSnapshotsMock.mockReset();
    warmEnabledProviderSnapshotsMock.mockResolvedValue(undefined);
    getSettingsMock.mockReset();
    getSettingsMock.mockReturnValue(null);
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
    expect(body).toEqual({ ...snapshot, schedulerThrottle: null });
  });

  it('returns 502 when underlying fetcher throws', async () => {
    getQuotaForProviderMock.mockRejectedValue(new Error('No token'));

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/No token/);
  });

  it('does not expose raw Anthropic 429 cache internals', async () => {
    getQuotaForProviderMock.mockRejectedValue(new Error('Anthropic usage API rate-limited (429); no cached value to return'));

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota?provider=claude'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('Claude quota temporarily unavailable');
    expect(body.error).not.toContain('no cached value to return');
  });

  it('does not expose ISO retry timestamp from backing-off error', async () => {
    const isoTimestamp = new Date(Date.now() + 60_000).toISOString();
    getQuotaForProviderMock.mockRejectedValue(
      new Error(`Claude quota temporarily unavailable; backing off after Anthropic usage API rate limit until ${isoTimestamp}`)
    );

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota?provider=claude'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('Claude quota temporarily unavailable');
    expect(body.error).not.toContain(isoTimestamp);
    expect(body.error).not.toContain('backing off');
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
    expect(warmEnabledProviderSnapshotsMock).toHaveBeenCalledWith({ force: true });
    const body = await res.json();
    expect(body).toEqual({ ...snapshot, schedulerThrottle: null });
  });

  it('exposes schedulerThrottle: null when no provider is over the weekly burn cap', async () => {
    getQuotaForProviderMock.mockResolvedValue({
      fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 5, resetsAt: null, msUntilReset: null },
      fetchedAt: 1, stale: false, gateEnabled: true,
    });
    scheduledBurnRateBlockedAcrossProvidersMock.mockReturnValue(null);

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota'));
    const body = await res.json();
    expect(body.schedulerThrottle).toBeNull();
  });

  it('exposes schedulerThrottle payload when every enabled provider is over the cap', async () => {
    getSettingsMock.mockReturnValue({ budget_block_runs_enabled: true, claude_provider: 'claude' });
    getQuotaForProviderMock.mockResolvedValue({
      fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 80, resetsAt: null, msUntilReset: null },
      fetchedAt: 1, stale: false, gateEnabled: true,
    });
    scheduledBurnRateBlockedAcrossProvidersMock.mockReturnValue({
      reason: '7d burn rate too high: 80% used, projected 160%',
      projectedPct: 160,
      worstProvider: 'claude',
      resumesAtMs: Date.now() + 60_000,
    });

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota'));
    const body = await res.json();
    expect(body.schedulerThrottle).toMatchObject({
      worstProvider: 'claude',
      projectedPct: 160,
    });
    expect(body.gateEnabled).toBe(true);
  });

  it('exposes schedulerThrottle when a quota-aware sibling is unavailable and the known provider is over the weekly cap', async () => {
    getSettingsMock.mockReturnValue({ budget_block_runs_enabled: true, claude_provider: 'claude' });
    getQuotaForProviderMock.mockResolvedValue({
      fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 80, resetsAt: null, msUntilReset: null },
      fetchedAt: 1, stale: false, gateEnabled: true,
    });
    scheduledBurnRateBlockedAcrossProvidersMock.mockReturnValue({
      reason: '7d burn rate too high: 80% used, projected 160%',
      projectedPct: 160,
      worstProvider: 'claude',
      resumesAtMs: Date.now() + 60_000,
    });

    const { GET } = await import('@/app/api/usage/quota/route');
    const res = await GET(new NextRequest('http://localhost/api/usage/quota'));
    const body = await res.json();
    expect(body.schedulerThrottle).toMatchObject({
      worstProvider: 'claude',
      projectedPct: 160,
    });
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
    expect(warmEnabledProviderSnapshotsMock).toHaveBeenCalledWith();
  });
});
