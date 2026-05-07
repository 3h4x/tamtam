import { describe, expect, it } from 'vitest';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import type { CliProvider } from '@/lib/usage/cli-providers';
import { pickCliProvider } from '@/lib/usage/cli-picker';

function snapshot(provider: 'claude' | 'codex', utilization: number): QuotaSnapshot {
  return {
    provider,
    fiveHour: { utilization, resetsAt: null, msUntilReset: null },
    sevenDay: { utilization, resetsAt: null, msUntilReset: null },
    fetchedAt: 0,
    stale: false,
  };
}

describe('pickCliProvider', () => {
  it('picks the enabled CLI with the most remaining headroom', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 70)],
      ['codex', snapshot('codex', 20)],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('codex');
    expect(result.utilization).toBe(20);
  });

  it('skips a provider that is over the block threshold and falls back to a healthy one', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 99)],
      ['codex', snapshot('codex', 50)],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('codex');
  });

  it('returns null when every enabled provider is over budget', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 99)],
      ['codex', snapshot('codex', 99)],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBeNull();
    expect(result.reason).toBe('all_blocked');
  });

  it('treats providers without a snapshot (gemini, lmstudio) as 0% utilization', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 80)],
      ['lmstudio', null],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'lmstudio'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('lmstudio');
  });

  it('breaks ties using the order of `enabled`', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 0)],
      ['codex', snapshot('codex', 0)],
    ]);
    const result = pickCliProvider({
      enabled: ['codex', 'claude'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('codex');
  });

  it('respects the credit-window utilization (extra) when higher than 5h', () => {
    const snap: QuotaSnapshot = {
      provider: 'codex',
      fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
      extra: { isEnabled: true, monthlyLimit: null, usedCredits: null, utilization: 99, currency: null },
      fetchedAt: 0,
      stale: false,
    };
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 50)],
      ['codex', snap],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('claude');
  });

  it('returns null with no_enabled_providers reason when enabled is empty', () => {
    const result = pickCliProvider({
      enabled: [],
      snapshots: new Map(),
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBeNull();
    expect(result.reason).toBe('no_enabled_providers');
  });

  it('uses 7d burn when scoring provider headroom', () => {
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    const claudeSnap: QuotaSnapshot = {
      provider: 'claude',
      fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 71, resetsAt: null, msUntilReset: threeDaysMs },
      fetchedAt: 0,
      stale: false,
    };
    const codexSnap: QuotaSnapshot = {
      provider: 'codex',
      fiveHour: { utilization: 35, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 34, resetsAt: null, msUntilReset: fourDaysMs },
      fetchedAt: 0,
      stale: false,
    };
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', claudeSnap],
      ['codex', codexSnap],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('codex');
  });

  it('does not hard-block a provider on weekly burn alone', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 97, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('claude');
  });

  it('uses 7d burn for fallback selection even when hard blocking is off', () => {
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const claudeSnap: QuotaSnapshot = {
      provider: 'claude',
      fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 71, resetsAt: null, msUntilReset: threeDaysMs },
      fetchedAt: 0,
      stale: false,
    };
    const codexSnap: QuotaSnapshot = {
      provider: 'codex',
      fiveHour: { utilization: 20, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 34, resetsAt: null, msUntilReset: threeDaysMs },
      fetchedAt: 0,
      stale: false,
    };
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', claudeSnap],
      ['codex', codexSnap],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: false,
    });
    expect(result.provider).toBe('codex');
  });

  it('respects model-specific weekly windows when they are higher than aggregate weekly usage', () => {
    const claudeSnap: QuotaSnapshot = {
      provider: 'claude',
      fiveHour: { utilization: 0, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 40, resetsAt: null, msUntilReset: null },
      sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
      sevenDayOpus: null,
      fetchedAt: 0,
      stale: false,
    };
    const codexSnap: QuotaSnapshot = {
      provider: 'codex',
      fiveHour: { utilization: 0, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 25, resetsAt: null, msUntilReset: null },
      fetchedAt: 0,
      stale: false,
    };
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', claudeSnap],
      ['codex', codexSnap],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
      requestedModel: 'normal',
    });
    expect(result.provider).toBe('codex');
  });

  it('ignores unrelated Claude model windows when the requested tier is different', () => {
    const claudeSnap: QuotaSnapshot = {
      provider: 'claude',
      fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 20, resetsAt: null, msUntilReset: null },
      sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
      sevenDayOpus: null,
      fetchedAt: 0,
      stale: false,
    };
    const codexSnap: QuotaSnapshot = {
      provider: 'codex',
      fiveHour: { utilization: 30, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 50, resetsAt: null, msUntilReset: null },
      fetchedAt: 0,
      stale: false,
    };
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', claudeSnap],
      ['codex', codexSnap],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
      requestedModel: 'fast',
    });
    expect(result.provider).toBe('claude');
  });

  it('does not block any provider when blockEnabled is false', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 99)],
      ['codex', snapshot('codex', 99)],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: false,
    });
    expect(result.provider).toBe('claude');
  });
});
