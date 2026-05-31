import { describe, expect, it } from 'vitest';
import {
  decideBoosts,
  pruneBoostHistory,
  recordBoosts,
  type BoostAgentInput,
  type BoostHistoryInput,
  type BoostInput,
  type BoostPaceInput,
  type BoostProjectInput,
} from '@/lib/orchestrator/budget-allocator';

const NOW = 1_700_000_000_000;

function makeAgent(overrides: Partial<BoostAgentInput> = {}): BoostAgentInput {
  return {
    id: 'agent-1',
    name: 'improve',
    project: 'borged',
    enabled: true,
    schedule: '15m',
    lastDispatchMs: null,
    kind: 'user',
    boostable: true,
    ...overrides,
  };
}

function makeProject(overrides: Partial<BoostProjectInput> = {}): BoostProjectInput {
  return {
    project: 'borged',
    status: 'shipping',
    paused: false,
    releaseRunning: false,
    lastPushAt: 1_699_999_000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<BoostInput> = {}): BoostInput {
  const pace: BoostPaceInput = { status: 'under_pace', marginPct: 20 };
  return {
    pace,
    projects: [makeProject()],
    agents: [makeAgent()],
    history: { byProject: new Map() },
    settings: { marginPct: 5, maxBoostsPerHour: 2 },
    nowMs: NOW,
    ...overrides,
  };
}

describe('decideBoosts', () => {
  it('returns no boosts when pace is on_pace or over_pace', () => {
    expect(decideBoosts(makeInput({ pace: { status: 'on_pace', marginPct: 0 } }))).toEqual([]);
    expect(decideBoosts(makeInput({ pace: { status: 'over_pace', marginPct: -2 } }))).toEqual([]);
    expect(decideBoosts(makeInput({ pace: { status: 'paused', marginPct: 0 } }))).toEqual([]);
    expect(decideBoosts(makeInput({ pace: { status: 'unknown', marginPct: 0 } }))).toEqual([]);
  });

  it('returns no boosts when margin is below the configured threshold', () => {
    const r = decideBoosts(makeInput({
      pace: { status: 'under_pace', marginPct: 3 },
      settings: { marginPct: 5, maxBoostsPerHour: 2 },
    }));
    expect(r).toEqual([]);
  });

  it('boosts a shipping project with eligible agent when pace has headroom', () => {
    const r = decideBoosts(makeInput());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ project: 'borged', agentId: 'agent-1', agentName: 'improve' });
  });

  it('does not boost a paused project', () => {
    const r = decideBoosts(makeInput({ projects: [makeProject({ paused: true })] }));
    expect(r).toEqual([]);
  });

  it('still boosts while a release is running (parallel agents lifted the old exclusion)', () => {
    // Pre-existing test asserted releaseRunning blocked boosts. The new policy
    // lets agents run alongside releases — per-project agent serialization
    // happens at the pending-agent-run layer, not here.
    const r = decideBoosts(makeInput({ projects: [makeProject({ releaseRunning: true })] }));
    expect(r).toHaveLength(1);
  });

  it('boosts shipping/active/idle/attention but not releasing/error/paused/stuck', () => {
    // marginPct=8 keeps slack below the severely-under threshold so we exercise
    // the default boost set, not the widened one.
    const pace = { status: 'under_pace' as const, marginPct: 8 };
    for (const status of ['shipping', 'active', 'idle', 'attention']) {
      const r = decideBoosts(makeInput({ pace, projects: [makeProject({ status })] }));
      expect(r, `status=${status} should boost`).toHaveLength(1);
    }
    for (const status of ['releasing', 'agent_running', 'error', 'stuck', 'paused']) {
      const r = decideBoosts(makeInput({ pace, projects: [makeProject({ status })] }));
      expect(r, `status=${status} should not boost`).toEqual([]);
    }
  });

  it('skips agents flagged boostable=false even when under pace', () => {
    // A blog-writer style agent should fire only on its own schedule, never
    // via a boost — even with maximum slack.
    const r = decideBoosts(makeInput({
      pace: { status: 'under_pace', marginPct: 40 },
      agents: [makeAgent({ name: 'blog', boostable: false })],
    }));
    expect(r).toEqual([]);
  });

  it('widens to agent_running when severely under pace', () => {
    const r = decideBoosts(makeInput({
      pace: { status: 'under_pace', marginPct: 30 },
      projects: [makeProject({ status: 'agent_running' })],
    }));
    expect(r).toHaveLength(1);
  });

  it('caps boosts at maxBoostsPerHour per project within the rolling window', () => {
    const history: BoostHistoryInput = {
      byProject: new Map([
        ['borged', [NOW - 10 * 60 * 1000, NOW - 5 * 60 * 1000]],
      ]),
    };
    const r = decideBoosts(makeInput({
      history,
      settings: { marginPct: 5, maxBoostsPerHour: 2 },
    }));
    expect(r).toEqual([]);
  });

  it('ignores history entries older than the rolling window', () => {
    const history: BoostHistoryInput = {
      byProject: new Map([
        // 90 minutes ago — outside the 60-min window
        ['borged', [NOW - 90 * 60 * 1000, NOW - 80 * 60 * 1000]],
      ]),
    };
    const r = decideBoosts(makeInput({
      history,
      settings: { marginPct: 5, maxBoostsPerHour: 2 },
    }));
    expect(r).toHaveLength(1);
  });

  it('skips agents that fired in the last 5 minutes', () => {
    const r = decideBoosts(makeInput({
      agents: [makeAgent({ lastDispatchMs: NOW - 2 * 60 * 1000 })],
    }));
    expect(r).toEqual([]);
  });

  it('still boosts an agent whose prior real dispatch is outside the cooldown even if it was queued later', () => {
    const r = decideBoosts(makeInput({
      agents: [
        makeAgent({ id: 'a-queued', name: 'queued-later', lastDispatchMs: NOW - 10 * 60 * 1000 }),
        makeAgent({ id: 'a-recent', name: 'recent', lastDispatchMs: NOW - 2 * 60 * 1000 }),
      ],
    }));
    expect(r).toHaveLength(1);
    expect(r[0].agentId).toBe('a-queued');
  });

  it('picks the agent with the oldest lastDispatchMs', () => {
    // marginPct=5 keeps slack==0 so only one pick fires; the test isolates
    // the staleness ranking without engaging the multi-pick boost.
    const r = decideBoosts(makeInput({
      pace: { status: 'under_pace', marginPct: 5 },
      agents: [
        makeAgent({ id: 'a-recent', name: 'recent', lastDispatchMs: NOW - 10 * 60 * 1000 }),
        makeAgent({ id: 'a-old', name: 'old', lastDispatchMs: NOW - 60 * 60 * 1000 }),
        makeAgent({ id: 'a-never', name: 'never', lastDispatchMs: null }),
      ],
    }));
    expect(r).toHaveLength(1);
    expect(r[0].agentId).toBe('a-never');
  });

  it('boosts multiple agents per project when pace headroom is large', () => {
    const r = decideBoosts(makeInput({
      pace: { status: 'under_pace', marginPct: 25 },
      settings: { marginPct: 5, maxBoostsPerHour: 3 },
      agents: [
        makeAgent({ id: 'a-never', name: 'never', lastDispatchMs: null }),
        makeAgent({ id: 'a-old', name: 'old', lastDispatchMs: NOW - 60 * 60 * 1000 }),
        makeAgent({ id: 'a-mid', name: 'mid', lastDispatchMs: NOW - 30 * 60 * 1000 }),
      ],
    }));
    // slack=20 → desiredPicks=min(5,1+2)=3 picks; budget=3 unused; expect 3.
    expect(r).toHaveLength(3);
    expect(r.map((d) => d.agentId)).toEqual(['a-never', 'a-old', 'a-mid']);
  });

  it('skips disabled agents and agents without a schedule', () => {
    const r = decideBoosts(makeInput({
      agents: [
        makeAgent({ id: 'a-disabled', enabled: false }),
        makeAgent({ id: 'a-no-schedule', schedule: null }),
        makeAgent({ id: 'a-empty-schedule', schedule: '   ' }),
      ],
    }));
    expect(r).toEqual([]);
  });

  it('emits one boost per eligible project independently', () => {
    const r = decideBoosts(makeInput({
      projects: [
        makeProject({ project: 'borged' }),
        makeProject({ project: 'other', status: 'active' }),
        makeProject({ project: 'sleepy', status: 'idle' }),
        makeProject({ project: 'broken', status: 'error' }),
      ],
      agents: [
        makeAgent({ id: 'a-borged', project: 'borged' }),
        makeAgent({ id: 'a-other', project: 'other' }),
        makeAgent({ id: 'a-sleepy', project: 'sleepy' }),
        makeAgent({ id: 'a-broken', project: 'broken' }),
      ],
    }));
    // idle is in the boost set; error is not.
    expect(r).toHaveLength(3);
    expect(r.map((d) => d.project).sort()).toEqual(['borged', 'other', 'sleepy']);
  });

  it('boosts when 7d weekly margin is behind even if 5h short window is on_pace', () => {
    const r = decideBoosts(makeInput({
      pace: { status: 'on_pace', marginPct: -2, weeklyMarginPct: 30 },
    }));
    expect(r).toHaveLength(1);
    // weekly margin 30 wins over the -2 short window → ~30% headroom in the reason
    expect(r[0].reason).toContain('30% budget headroom');
  });

  it('uses the larger of short/weekly margin for multi-pick slack', () => {
    const r = decideBoosts(makeInput({
      pace: { status: 'on_pace', marginPct: -5, weeklyMarginPct: 25 },
      settings: { marginPct: 5, maxBoostsPerHour: 5 },
      agents: [
        makeAgent({ id: 'a', lastDispatchMs: null }),
        makeAgent({ id: 'b', lastDispatchMs: NOW - 30 * 60 * 1000 }),
        makeAgent({ id: 'c', lastDispatchMs: NOW - 60 * 60 * 1000 }),
      ],
    }));
    // slack = 25 - 5 = 20 → desiredPicks = min(5, 1+2) = 3
    expect(r).toHaveLength(3);
  });

  it('promotes boosted runs to smart model when slack exceeds the aggressive-catchup threshold', () => {
    // slack = 20 - 5 = 15 → above AGGRESSIVE_CATCHUP_PP (10)
    const r = decideBoosts(makeInput({
      pace: { status: 'under_pace', marginPct: 20 },
    }));
    expect(r).toHaveLength(1);
    expect(r[0].modelOverride).toBe('smart');
    expect(r[0].reason).toContain('smart mode');
  });

  it('does not promote when slack is below the aggressive-catchup threshold', () => {
    // slack = 12 - 5 = 7 → below threshold (10), no override
    const r = decideBoosts(makeInput({
      pace: { status: 'under_pace', marginPct: 12 },
    }));
    expect(r).toHaveLength(1);
    expect(r[0].modelOverride).toBeUndefined();
  });

  it('does not boost when both short and weekly margins are below the floor', () => {
    const r = decideBoosts(makeInput({
      pace: { status: 'on_pace', marginPct: -3, weeklyMarginPct: 2 },
    }));
    expect(r).toEqual([]);
  });

  it('returns nothing when maxBoostsPerHour is zero (kill switch via setting)', () => {
    const r = decideBoosts(makeInput({
      settings: { marginPct: 5, maxBoostsPerHour: 0 },
    }));
    expect(r).toEqual([]);
  });

  describe('fruitfulness deprioritization', () => {
    it('prefers a fruitful agent over an unfruitful one even when unfruitful is staler', () => {
      const r = decideBoosts(makeInput({
        pace: { status: 'under_pace', marginPct: 5 },
        agents: [
          // staler dispatch but proven unfruitful
          makeAgent({
            id: 'a-stuck',
            name: 'stuck',
            lastDispatchMs: NOW - 60 * 60 * 1000,
            fruitfulness: { rate: 0, runs: 10 },
          }),
          // less stale but fruitful
          makeAgent({
            id: 'a-good',
            name: 'good',
            lastDispatchMs: NOW - 20 * 60 * 1000,
            fruitfulness: { rate: 0.7, runs: 10 },
          }),
        ],
      }));
      expect(r).toHaveLength(1);
      expect(r[0].agentId).toBe('a-good');
    });

    it('still picks an unfruitful agent when it is the only candidate', () => {
      const r = decideBoosts(makeInput({
        pace: { status: 'under_pace', marginPct: 5 },
        agents: [
          makeAgent({
            id: 'a-stuck',
            name: 'stuck',
            lastDispatchMs: null,
            fruitfulness: { rate: 0, runs: 10 },
          }),
        ],
      }));
      // Tier-2 fallback fires when tier-1 is empty — better to keep some
      // forward progress than waste pace headroom entirely.
      expect(r).toHaveLength(1);
      expect(r[0].agentId).toBe('a-stuck');
    });

    it('does not demote agents below the minimum sample size', () => {
      // Only 3 runs of empty output is "new agent settling in", not "stuck".
      const r = decideBoosts(makeInput({
        pace: { status: 'under_pace', marginPct: 5 },
        agents: [
          makeAgent({
            id: 'a-new',
            name: 'new',
            lastDispatchMs: NOW - 60 * 60 * 1000,
            fruitfulness: { rate: 0, runs: 3 },
          }),
          makeAgent({
            id: 'a-good',
            name: 'good',
            lastDispatchMs: NOW - 20 * 60 * 1000,
            fruitfulness: { rate: 0.7, runs: 10 },
          }),
        ],
      }));
      // a-new isn't demoted yet → it's the staler one → it wins on staleness.
      expect(r).toHaveLength(1);
      expect(r[0].agentId).toBe('a-new');
    });

    it('does not penalize agents with no fruitfulness signal', () => {
      // Missing data is treated as "unknown" → fair shake, not demoted.
      const r = decideBoosts(makeInput({
        pace: { status: 'under_pace', marginPct: 5 },
        agents: [
          makeAgent({
            id: 'a-unknown',
            name: 'unknown',
            lastDispatchMs: NOW - 60 * 60 * 1000,
            // fruitfulness intentionally absent
          }),
          makeAgent({
            id: 'a-good',
            name: 'good',
            lastDispatchMs: NOW - 20 * 60 * 1000,
            fruitfulness: { rate: 0.7, runs: 10 },
          }),
        ],
      }));
      expect(r).toHaveLength(1);
      expect(r[0].agentId).toBe('a-unknown');
    });

    it('demotes only agents whose rate is strictly below the threshold (20%)', () => {
      // rate exactly at 0.2 must NOT be demoted — boundary check.
      const r = decideBoosts(makeInput({
        pace: { status: 'under_pace', marginPct: 5 },
        agents: [
          makeAgent({
            id: 'a-borderline',
            name: 'borderline',
            lastDispatchMs: NOW - 60 * 60 * 1000,
            fruitfulness: { rate: 0.2, runs: 10 },
          }),
          makeAgent({
            id: 'a-good',
            name: 'good',
            lastDispatchMs: NOW - 20 * 60 * 1000,
            fruitfulness: { rate: 0.7, runs: 10 },
          }),
        ],
      }));
      // a-borderline at exactly the threshold stays in tier 1 → wins on staleness.
      expect(r).toHaveLength(1);
      expect(r[0].agentId).toBe('a-borderline');
    });

    it('still demotes when slack lets multiple picks fire', () => {
      const r = decideBoosts(makeInput({
        pace: { status: 'under_pace', marginPct: 25 },
        settings: { marginPct: 5, maxBoostsPerHour: 5 },
        agents: [
          makeAgent({ id: 'a-stuck', name: 'stuck', lastDispatchMs: null, fruitfulness: { rate: 0, runs: 10 } }),
          makeAgent({ id: 'a-good-1', name: 'g1', lastDispatchMs: NOW - 60 * 60 * 1000, fruitfulness: { rate: 0.8, runs: 10 } }),
          makeAgent({ id: 'a-good-2', name: 'g2', lastDispatchMs: NOW - 30 * 60 * 1000, fruitfulness: { rate: 0.5, runs: 10 } }),
        ],
      }));
      // slack=20 → desiredPicks=3; tier order is g1, g2, then stuck.
      expect(r.map((d) => d.agentId)).toEqual(['a-good-1', 'a-good-2', 'a-stuck']);
    });
  });
});

describe('pruneBoostHistory', () => {
  it('drops entries older than the rolling window and keeps recent ones', () => {
    const before: BoostHistoryInput = {
      byProject: new Map([
        ['borged', [NOW - 90 * 60 * 1000, NOW - 30 * 60 * 1000, NOW - 5 * 60 * 1000]],
        ['stale', [NOW - 120 * 60 * 1000]],
      ]),
    };
    const after = pruneBoostHistory(before, NOW);
    expect(after.byProject.get('borged')).toEqual([NOW - 30 * 60 * 1000, NOW - 5 * 60 * 1000]);
    expect(after.byProject.has('stale')).toBe(false);
  });
});

describe('recordBoosts', () => {
  it('appends timestamps per decision without mutating the input map', () => {
    const before: BoostHistoryInput = {
      byProject: new Map([['borged', [NOW - 10 * 60 * 1000]]]),
    };
    const after = recordBoosts(before, [
      { project: 'borged', agentId: 'a', agentName: 'n', reason: 'r' },
      { project: 'other', agentId: 'b', agentName: 'm', reason: 'r' },
    ], NOW);
    // Original untouched
    expect(before.byProject.get('borged')).toEqual([NOW - 10 * 60 * 1000]);
    // New map has appended entries
    expect(after.byProject.get('borged')).toEqual([NOW - 10 * 60 * 1000, NOW]);
    expect(after.byProject.get('other')).toEqual([NOW]);
  });

  it('returns the input unchanged when there are no decisions', () => {
    const before: BoostHistoryInput = { byProject: new Map() };
    const after = recordBoosts(before, [], NOW);
    expect(after).toBe(before);
  });
});
