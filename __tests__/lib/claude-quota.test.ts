import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const execMock = vi.fn();
const fetchMock = vi.fn();
const readFileMock = vi.fn();

vi.mock('@/lib/shared/shell', () => ({
  exec: execMock,
}));

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
}));

interface CacheState {
  snapshot: unknown;
  fetchedAt: number;
  retryAfterMs: number;
  rateLimitFailures?: number;
  inFlight: Promise<unknown> | null;
}

const FAKE_RESPONSE = {
  five_hour: { utilization: 55, resets_at: '2099-01-01T00:00:00Z' },
  seven_day: { utilization: 46, resets_at: '2099-01-08T00:00:00Z' },
  seven_day_sonnet: { utilization: 49, resets_at: '2099-01-08T00:00:00Z' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
};

function makeRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function clearGlobalCache() {
  delete (globalThis as unknown as { __tamtamQuota?: CacheState }).__tamtamQuota;
}

describe('claude-quota', () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    fetchMock.mockReset();
    readFileMock.mockReset();
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    clearGlobalCache();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    clearGlobalCache();
  });

  it('reads token from keychain on darwin and fetches snapshot', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    execMock.mockResolvedValue({
      stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123' } }),
      stderr: '',
      exitCode: 0,
    });
    fetchMock.mockResolvedValue(makeRes(FAKE_RESPONSE));

    const { getClaudeQuota } = await import('@/lib/usage/claude-quota');
    const snap = await getClaudeQuota();

    expect(snap.fiveHour.utilization).toBe(55);
    expect(snap.sevenDay.utilization).toBe(46);
    expect(snap.sevenDaySonnet?.utilization).toBe(49);
    expect(snap.sevenDayOpus).toBeNull();
    expect(snap.stale).toBe(false);
    expect(execMock).toHaveBeenCalledWith('security', expect.arrayContaining(['find-generic-password']), expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }) })
    );

    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('throws when token cannot be found and no cache exists', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });

    const { getClaudeQuota } = await import('@/lib/usage/claude-quota');
    await expect(getClaudeQuota()).rejects.toThrow(/No Claude OAuth token/);
  });

  it('returns stale cached snapshot on rate-limit (429)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    // First successful call to seed cache
    fetchMock.mockResolvedValueOnce(makeRes(FAKE_RESPONSE));
    // Second call returns 429
    fetchMock.mockResolvedValueOnce(makeRes({}, 429, { 'retry-after': '600' }));

    const { getClaudeQuota, clearQuotaCache } = await import('@/lib/usage/claude-quota');

    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } })
    );

    const first = await getClaudeQuota();
    expect(first.stale).toBe(false);

    // Force a fresh fetch (bypass TTL) to hit the 429
    clearQuotaCache();
    // re-seed cache with first snapshot via direct manipulation
    (globalThis as unknown as { __tamtamQuota?: CacheState }).__tamtamQuota = {
      snapshot: first,
      fetchedAt: 0, // expired so we attempt fetch
      retryAfterMs: 0,
      rateLimitFailures: 0,
      inFlight: null,
    };

    const second = await getClaudeQuota();
    expect(second.stale).toBe(true);
    expect(second.fiveHour.utilization).toBe(55);
  });

  it('backs off after rate-limit when no cached snapshot exists', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } })
    );
    fetchMock.mockResolvedValue(makeRes({}, 429));

    const { getClaudeQuota } = await import('@/lib/usage/claude-quota');

    await expect(getClaudeQuota()).rejects.toThrow(/rate-limited/);
    await expect(getClaudeQuota()).rejects.toThrow(/backing off/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns cached snapshot within TTL without re-fetching', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } })
    );

    fetchMock.mockResolvedValue(makeRes(FAKE_RESPONSE));

    const { getClaudeQuota } = await import('@/lib/usage/claude-quota');
    const a = await getClaudeQuota();
    const b = await getClaudeQuota();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it('returns a static healthy snapshot in QA mode without hitting the network', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.TAMTAM_QA_MODE = '1';
    try {
      const { getClaudeQuota } = await import('@/lib/usage/claude-quota');
      const snap = await getClaudeQuota();
      expect(snap.fiveHour.utilization).toBe(0);
      expect(snap.sevenDay.utilization).toBe(0);
      expect(snap.stale).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(execMock).not.toHaveBeenCalled();
      expect(readFileMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.TAMTAM_QA_MODE;
    }
  });
});
