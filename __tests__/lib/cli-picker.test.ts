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

  it('returns null when one quota-aware provider is over budget and the sibling snapshot is missing', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', snapshot('claude', 99)],
      ['codex', null],
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

  it('picks the provider with usable pace+burst when only one is over the weekly cap', () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 99, resetsAt: null, msUntilReset: null },
        fetchedAt: 0, stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0, stale: false,
      }],
    ]);
    const result = pickCliProvider({
      enabled: ['claude', 'codex'],
      snapshots,
      budgetBlockAtPct: 95,
      blockEnabled: true,
    });
    expect(result.provider).toBe('codex');
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

  describe('pace-aware routing', () => {
    it('picks the provider most behind on pace when headroom is similar', () => {
      // Claude: 50% util, 60% elapsed = -10pp margin (behind)
      // Codex: 50% util, 50% elapsed = 0pp margin (on pace)
      // Both have 50 headroom, but Claude should win because it's more behind
      const claudeSnap: QuotaSnapshot = {
        provider: 'claude',
        fiveHour: { utilization: 50, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 50, resetsAt: null, msUntilReset: 3 * 24 * 60 * 60 * 1000 },
        fetchedAt: 0,
        stale: false,
      };
      const codexSnap: QuotaSnapshot = {
        provider: 'codex',
        fiveHour: { utilization: 50, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 50, resetsAt: null, msUntilReset: 3.5 * 24 * 60 * 60 * 1000 },
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
      expect(result.provider).toBe('claude');
    });

    it('picks higher-headroom provider when pace margins are equal', () => {
      // Both 10% behind pace (margin = -10), but Claude has 60 headroom vs Codex 40
      const claudeSnap: QuotaSnapshot = {
        provider: 'claude',
        fiveHour: { utilization: 40, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 40, resetsAt: null, msUntilReset: 3 * 24 * 60 * 60 * 1000 },
        fetchedAt: 0,
        stale: false,
      };
      const codexSnap: QuotaSnapshot = {
        provider: 'codex',
        fiveHour: { utilization: 60, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 60, resetsAt: null, msUntilReset: 3 * 24 * 60 * 60 * 1000 },
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
      expect(result.provider).toBe('claude');
    });

    it('weights pace margin heavily so a more-behind provider wins despite lower headroom', () => {
      // Claude: 30% util, 60% elapsed = -30pp margin, 70 headroom (score: -30*10 + 0.7 = -299.3)
      // Codex: 10% util, 50% elapsed = -40pp margin, 90 headroom (score: -40*10 + 0.9 = -399.1)
      // Higher (less negative) score wins → Claude
      // But if we swap: Codex with 20% util (margin -30pp), 80 headroom vs Claude with margin -40pp:
      // Codex: -30*10 + 0.8 = -299.2 vs Claude: -40*10 + 0.7 = -399.3 → Codex wins (more behind)
      const claudeSnap: QuotaSnapshot = {
        provider: 'claude',
        fiveHour: { utilization: 20, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 20, resetsAt: null, msUntilReset: 2.92 * 24 * 60 * 60 * 1000 },
        fetchedAt: 0,
        stale: false,
      };
      const codexSnap: QuotaSnapshot = {
        provider: 'codex',
        fiveHour: { utilization: 10, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: 2.83 * 24 * 60 * 60 * 1000 },
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
      // Codex is more behind, should win
      expect(result.provider).toBe('codex');
    });

    it('treats missing snapshot (no pace margin) as fully available when provider is non-quota-aware', () => {
      // Claude: known snapshot, 70% util on 7d (margin -20pp)
      // LMStudio: no snapshot (non-quota-aware), treated as 0% util → max headroom, no pace margin
      // Both are enabled. LMStudio should win on headroom (100 vs 30), score 1 vs -199.7
      const claudeSnap: QuotaSnapshot = {
        provider: 'claude',
        fiveHour: { utilization: 70, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 70, resetsAt: null, msUntilReset: 3.5 * 24 * 60 * 60 * 1000 },
        fetchedAt: 0,
        stale: false,
      };
      const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
        ['claude', claudeSnap],
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
  });

  describe('weekly catchup mode (5h near-cap penalty suppression)', () => {
    // Setup: claude is materially behind on weekly pace AND its 5h window is
    // projected to land above 80%. Codex is mildly behind on pace with a fresh
    // 5h window. Without suppression, the near-cap penalty would shift traffic
    // away from claude — but that defeats the catchup goal of burning claude's
    // 7d budget while it has 5h headroom.
    function makeSnap(args: {
      provider: 'claude' | 'codex';
      fiveHourUtil: number;
      fiveHourMsUntilReset: number;
      sevenDayUtil: number;
      sevenDayMsUntilReset: number;
    }): QuotaSnapshot {
      return {
        provider: args.provider,
        fiveHour: { utilization: args.fiveHourUtil, resetsAt: null, msUntilReset: args.fiveHourMsUntilReset },
        sevenDay: { utilization: args.sevenDayUtil, resetsAt: null, msUntilReset: args.sevenDayMsUntilReset },
        fetchedAt: 0,
        stale: false,
      };
    }

    it('suppresses the 5h near-cap penalty below the block line when paceMargin >= 15pp so the behind provider keeps getting traffic', () => {
      // claude: paceMargin = 50 - 35 = 15 (catchup mode), 5h projected = 85 (above 80, penalty would normally apply)
      // codex:  paceMargin = 50 - 40 = 10, 5h fresh (no penalty)
      // With suppression, claude's score = (15/84)*1000; codex's = (10/84)*1000 → claude wins.
      const claudeSnap = makeSnap({
        provider: 'claude',
        fiveHourUtil: 85,
        fiveHourMsUntilReset: 0,
        sevenDayUtil: 35,
        sevenDayMsUntilReset: 3.5 * 24 * 60 * 60 * 1000,
      });
      const codexSnap = makeSnap({
        provider: 'codex',
        fiveHourUtil: 0,
        fiveHourMsUntilReset: 5 * 60 * 60 * 1000,
        sevenDayUtil: 40,
        sevenDayMsUntilReset: 3.5 * 24 * 60 * 60 * 1000,
      });
      const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
        ['claude', claudeSnap],
        ['codex', codexSnap],
      ]);
      const result = pickCliProvider({
        enabled: ['claude', 'codex'],
        snapshots,
        budgetBlockAtPct: 99,
        blockEnabled: true,
      });
      expect(result.provider).toBe('claude');
    });

    it('does not let weekly catch-up override an exhausted 5h window', () => {
      // Mirrors a live failure mode: Claude's weekly window needs catch-up and
      // resets soon, but its 5h window is already full; Codex has much more
      // immediate headroom and should receive the next root run.
      const claudeSnap = makeSnap({
        provider: 'claude',
        fiveHourUtil: 100,
        fiveHourMsUntilReset: 1.9 * 60 * 60 * 1000,
        sevenDayUtil: 71,
        sevenDayMsUntilReset: 15.9 * 60 * 60 * 1000,
      });
      const codexSnap = makeSnap({
        provider: 'codex',
        fiveHourUtil: 8,
        fiveHourMsUntilReset: 5.5 * 60 * 1000,
        sevenDayUtil: 17,
        sevenDayMsUntilReset: 75.1 * 60 * 60 * 1000,
      });
      const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
        ['codex', codexSnap],
        ['claude', claudeSnap],
      ]);
      const result = pickCliProvider({
        enabled: ['codex', 'claude'],
        snapshots,
        budgetBlockAtPct: 95,
        blockEnabled: false,
      });
      expect(result.provider).toBe('codex');
    });

    it('applies the 5h near-cap penalty when paceMargin < 15pp so traffic shifts away from a saturating provider', () => {
      // Same shape as above, but claude paceMargin = 50 - 36 = 14 (below catchup threshold).
      // Penalty applies fully (projected 95 → (95-80)/15 = 1.0 * urgency), claude score ≈ headroom/100,
      // codex unpenalized score = (10/84)*1000 → codex wins.
      const claudeSnap = makeSnap({
        provider: 'claude',
        fiveHourUtil: 95,
        fiveHourMsUntilReset: 0,
        sevenDayUtil: 36,
        sevenDayMsUntilReset: 3.5 * 24 * 60 * 60 * 1000,
      });
      const codexSnap = makeSnap({
        provider: 'codex',
        fiveHourUtil: 0,
        fiveHourMsUntilReset: 5 * 60 * 60 * 1000,
        sevenDayUtil: 40,
        sevenDayMsUntilReset: 3.5 * 24 * 60 * 60 * 1000,
      });
      const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
        ['claude', claudeSnap],
        ['codex', codexSnap],
      ]);
      const result = pickCliProvider({
        enabled: ['claude', 'codex'],
        snapshots,
        budgetBlockAtPct: 99,
        blockEnabled: true,
      });
      expect(result.provider).toBe('codex');
    });
  });
});
