import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearQuotaCache,
  getQuota,
  getQuotaForProvider,
  peekQuotaCache,
  prefetchQuota,
} from '@/lib/usage/quota';

const mocks = vi.hoisted(() => ({
  settings: { claude_provider: 'claude' },
  throwSettings: false,
  claude: {
    getQuota: vi.fn(),
    clearQuotaCache: vi.fn(),
    peekQuotaCache: vi.fn(),
    prefetchQuota: vi.fn(),
  },
  codex: {
    getQuota: vi.fn(),
    clearQuotaCache: vi.fn(),
    peekQuotaCache: vi.fn(),
    prefetchQuota: vi.fn(),
  },
}));

vi.mock('@/lib/shared/config', () => ({
  getSettings: vi.fn(() => {
    if (mocks.throwSettings) throw new Error('settings unavailable');
    return mocks.settings;
  }),
}));

vi.mock('@/lib/usage/claude-quota', () => ({
  getClaudeQuota: mocks.claude.getQuota,
  clearQuotaCache: mocks.claude.clearQuotaCache,
  peekQuotaCache: mocks.claude.peekQuotaCache,
  prefetchQuota: mocks.claude.prefetchQuota,
}));

vi.mock('@/lib/usage/codex-quota', () => ({
  getCodexQuota: mocks.codex.getQuota,
  clearCodexQuotaCache: mocks.codex.clearQuotaCache,
  peekCodexQuotaCache: mocks.codex.peekQuotaCache,
  prefetchCodexQuota: mocks.codex.prefetchQuota,
}));

describe('quota provider selector', () => {
  beforeEach(() => {
    mocks.settings = { claude_provider: 'claude' };
    mocks.throwSettings = false;
    Object.values(mocks.claude).forEach((mock) => mock.mockReset());
    Object.values(mocks.codex).forEach((mock) => mock.mockReset());
  });

  it('uses Claude quota by default and fails open when settings cannot load', async () => {
    const snapshot = { provider: 'claude' };
    mocks.throwSettings = true;
    mocks.claude.getQuota.mockResolvedValue(snapshot);

    await expect(getQuota({ force: true })).resolves.toBe(snapshot);

    expect(mocks.claude.getQuota).toHaveBeenCalledWith({ force: true });
    expect(mocks.codex.getQuota).not.toHaveBeenCalled();
  });

  it('uses Codex quota when Codex is the active provider', async () => {
    const snapshot = { provider: 'codex' };
    mocks.settings = { claude_provider: 'codex' };
    mocks.codex.getQuota.mockResolvedValue(snapshot);

    await expect(getQuota()).resolves.toBe(snapshot);

    expect(mocks.codex.getQuota).toHaveBeenCalledWith({});
    expect(mocks.claude.getQuota).not.toHaveBeenCalled();
  });

  it('honors explicit provider requests independently of active settings', async () => {
    const claudeSnapshot = { provider: 'claude' };
    const codexSnapshot = { provider: 'codex' };
    mocks.settings = { claude_provider: 'codex' };
    mocks.claude.getQuota.mockResolvedValue(claudeSnapshot);
    mocks.codex.getQuota.mockResolvedValue(codexSnapshot);

    await expect(getQuotaForProvider('claude', { force: true })).resolves.toBe(claudeSnapshot);
    await expect(getQuotaForProvider('codex')).resolves.toBe(codexSnapshot);

    expect(mocks.claude.getQuota).toHaveBeenCalledWith({ force: true });
    expect(mocks.codex.getQuota).toHaveBeenCalledWith({});
  });

  it('routes cache helpers to the active provider', () => {
    const cached = { provider: 'codex' };
    mocks.settings = { claude_provider: 'codex' };
    mocks.codex.peekQuotaCache.mockReturnValue(cached);

    clearQuotaCache();
    prefetchQuota();

    expect(peekQuotaCache()).toBe(cached);
    expect(mocks.codex.clearQuotaCache).toHaveBeenCalledOnce();
    expect(mocks.codex.prefetchQuota).toHaveBeenCalledOnce();
    expect(mocks.claude.clearQuotaCache).not.toHaveBeenCalled();
    expect(mocks.claude.prefetchQuota).not.toHaveBeenCalled();
  });
});
