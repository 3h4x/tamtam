import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getQuotaSnapshots } from '@/lib/usage/quota';

const mocks = vi.hoisted(() => ({
  claudeGetQuota: vi.fn(),
  codexGetQuota: vi.fn(),
}));

vi.mock('@/lib/shared/config', () => ({
  getSettings: vi.fn(() => ({ claude_provider: 'claude' })),
}));

vi.mock('@/lib/usage/claude-quota', () => ({
  getClaudeQuota: mocks.claudeGetQuota,
  clearQuotaCache: vi.fn(),
  peekQuotaCache: vi.fn(),
  prefetchQuota: vi.fn(),
}));

vi.mock('@/lib/usage/codex-quota', () => ({
  getCodexQuota: mocks.codexGetQuota,
  clearCodexQuotaCache: vi.fn(),
  peekCodexQuotaCache: vi.fn(),
  prefetchCodexQuota: vi.fn(),
}));

describe('getQuotaSnapshots', () => {
  beforeEach(() => {
    mocks.claudeGetQuota.mockReset();
    mocks.codexGetQuota.mockReset();
  });

  it('fetches supported provider snapshots and returns null for providers without fetchers', async () => {
    const claude = { provider: 'claude', fiveHour: { utilization: 25 } };
    const codex = { provider: 'codex', fiveHour: { utilization: 10 } };
    mocks.claudeGetQuota.mockResolvedValue(claude);
    mocks.codexGetQuota.mockResolvedValue(codex);

    const snapshots = await getQuotaSnapshots(['claude', 'gemini', 'codex', 'lmstudio'], {
      force: true,
    });

    expect(mocks.claudeGetQuota).toHaveBeenCalledWith({ force: true });
    expect(mocks.codexGetQuota).toHaveBeenCalledWith({ force: true });
    expect(snapshots.get('claude')).toBe(claude);
    expect(snapshots.get('codex')).toBe(codex);
    expect(snapshots.get('gemini')).toBeNull();
    expect(snapshots.get('lmstudio')).toBeNull();
  });

  it('fails open to null when a supported provider quota fetcher throws', async () => {
    mocks.claudeGetQuota.mockRejectedValue(new Error('boom'));
    mocks.codexGetQuota.mockResolvedValue({ provider: 'codex', fiveHour: { utilization: 5 } });

    const snapshots = await getQuotaSnapshots(['claude', 'codex']);

    expect(snapshots.get('claude')).toBeNull();
    expect(snapshots.get('codex')).toEqual({ provider: 'codex', fiveHour: { utilization: 5 } });
  });
});
