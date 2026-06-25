import { describe, expect, it } from 'vitest';
import {
  decideAutopilot,
  type AutopilotAgentInput,
  type AutopilotInput,
  type AutopilotSettings,
  type AutopilotState,
} from '@/lib/orchestrator/agent-autopilot';
import type { HealthAnalysisOutcome } from '@/lib/orchestrator/agent-health-analysis';
import type { AgentRole } from '@/lib/agents/roles';

const NOW = 1_700_000_000_000;

const SETTINGS: AutopilotSettings = {
  cadenceFloor: '4h',
  tierFloor: 'fast',
  idleStreak: 4,
  concernStreak: 2,
  unfruitfulRate: 0.2,
  unfruitfulMinSample: 5,
};

function makeAgent(overrides: Partial<AutopilotAgentInput> = {}): AutopilotAgentInput {
  return {
    id: 'agent-1',
    name: 'improve',
    project: 'borged',
    role: 'producer',
    kind: 'user',
    enabled: true,
    schedule: '30m',
    model: 'normal',
    autopilot: {},
    ...overrides,
  };
}

function outcome(overrides: Partial<HealthAnalysisOutcome> = {}): HealthAnalysisOutcome {
  return {
    agentId: 'agent-1',
    analyzed: true,
    latestRunStartedAt: NOW,
    ...overrides,
  };
}

function run(
  agents: AutopilotAgentInput[],
  outcomes: HealthAnalysisOutcome[],
  settings: AutopilotSettings = SETTINGS,
): ReturnType<typeof decideAutopilot> {
  const input: AutopilotInput = { agents, outcomes, settings, nowMs: NOW };
  return decideAutopilot(input);
}

describe('decideAutopilot — producer cadence throttle', () => {
  it('bumps the concern streak but does not throttle on a single loop verdict', () => {
    const [d] = run([makeAgent()], [outcome({ concern: true, concernType: 'loop' })]);
    expect(d.action).toBeUndefined();
    expect(d.persistState.concernStreak).toBe(1);
    expect(d.persistState.scheduleOverride).toBeUndefined();
  });

  it('throttles one ladder rung once the concern streak is sustained', () => {
    const agent = makeAgent({ autopilot: { concernStreak: 1 } });
    const [d] = run([agent], [outcome({ concern: true, concernType: 'noise' })]);
    expect(d.action?.kind).toBe('throttle');
    expect(d.action?.from).toBe('30m');
    expect(d.action?.to).toBe('1h'); // next slower rung above 30m
    expect(d.persistState.scheduleOverride).toBe('1h');
    expect(d.persistState.originalSchedule).toBe('30m');
    expect(d.persistState.concernStreak).toBe(0);
  });

  it('never throttles past the cadence floor', () => {
    const agent = makeAgent({
      schedule: '30m',
      autopilot: { concernStreak: 1, scheduleOverride: '4h', originalSchedule: '30m' },
    });
    const [d] = run([agent], [outcome({ concern: true, concernType: 'loop' })]);
    // current override 4h == floor → no further step
    expect(d.action).toBeUndefined();
    expect(d.persistState.scheduleOverride).toBe('4h');
  });

  it('does not throttle on drift/quality concerns (operator-owned)', () => {
    const agent = makeAgent({ autopilot: { concernStreak: 1 } });
    const [d] = run([agent], [outcome({ concern: true, concernType: 'quality' })]);
    expect(d.action).toBeUndefined();
    expect(d.persistState.concernStreak).toBe(1); // unchanged
  });

  it('restores cadence in full on a clean verdict', () => {
    const agent = makeAgent({
      autopilot: { concernStreak: 0, scheduleOverride: '1h', originalSchedule: '30m' },
    });
    const [d] = run([agent], [outcome({ concern: false, concernType: 'none' })]);
    expect(d.action?.kind).toBe('restore-cadence');
    expect(d.action?.to).toBe('30m');
    expect(d.persistState.scheduleOverride).toBeUndefined();
    expect(d.persistState.originalSchedule).toBeUndefined();
  });

  it('restores cadence when the agent ships a fruitful run', () => {
    const agent = makeAgent({
      autopilot: { scheduleOverride: '1h', originalSchedule: '30m' },
    });
    const [d] = run([agent], [outcome({ concern: true, concernType: 'loop', anyFruitful: true })]);
    expect(d.action?.kind).toBe('restore-cadence');
  });

  it('throttles a persistently unfruitful producer on the first pass — no loop/noise verdict needed', () => {
    const agent = makeAgent({ fruitfulness: { rate: 0.07, runs: 43 } });
    // Clean LLM verdict, but the rolling rate (7% over 43 runs) is below floor.
    const [d] = run([agent], [outcome({ concern: false, concernType: 'none' })]);
    expect(d.action?.kind).toBe('throttle');
    expect(d.action?.to).toBe('1h');
    expect(d.action?.reason).toMatch(/unfruitful/i);
    expect(d.persistState.scheduleOverride).toBe('1h');
  });

  it('a single fruitful run does NOT rescue a chronically unfruitful producer', () => {
    const agent = makeAgent({
      fruitfulness: { rate: 0.1, runs: 30 },
      autopilot: { scheduleOverride: '1h', originalSchedule: '30m' },
    });
    const [d] = run([agent], [outcome({ concern: true, concernType: 'loop', anyFruitful: true })]);
    // anyFruitful is true, but the rate is still below floor → no restore; it
    // throttles further instead.
    expect(d.action?.kind).not.toBe('restore-cadence');
    expect(d.action?.kind).toBe('throttle');
  });

  it('does not throttle on a healthy fruitfulness rate', () => {
    const agent = makeAgent({ fruitfulness: { rate: 0.5, runs: 40 } });
    const [d] = run([agent], [outcome({ concern: false, concernType: 'none' })]);
    expect(d.action).toBeUndefined();
  });

  it('does not throttle on a low rate below the minimum sample', () => {
    const agent = makeAgent({ fruitfulness: { rate: 0.0, runs: 3 } });
    const [d] = run([agent], [outcome({ concern: false, concernType: 'none' })]);
    expect(d.action).toBeUndefined();
  });
});

describe('decideAutopilot — monitor/reviewer/planner model downgrade', () => {
  const monitor = (o: Partial<AutopilotAgentInput> = {}) =>
    makeAgent({ id: 'mon', name: 'audit-logs', role: 'monitor', model: 'smart', schedule: '15m', ...o });

  it('NEVER cadence-throttles a monitor, even on repeated all-clear', () => {
    const a = monitor({ autopilot: { idleStreak: 10 } });
    const [d] = run([a], [outcome({ agentId: 'mon', allIdle: true, anyFruitful: false, concern: false })]);
    expect(d.action?.kind).not.toBe('throttle');
    expect(d.persistState.scheduleOverride).toBeUndefined();
  });

  it('downgrades the model after a sustained all-clear streak', () => {
    const a = monitor({ autopilot: { idleStreak: 3 } });
    const [d] = run([a], [outcome({ agentId: 'mon', allIdle: true, anyFruitful: false, concern: false })]);
    expect(d.action?.kind).toBe('downgrade');
    expect(d.action?.from).toBe('smart');
    expect(d.action?.to).toBe('normal');
    expect(d.persistState.modelOverride).toBe('normal');
    expect(d.persistState.originalModel).toBe('smart');
    expect(d.persistState.idleStreak).toBe(0);
  });

  it('treats a no-concern non-fruitful LLM verdict as all-clear (not just regex idle)', () => {
    const a = monitor({ autopilot: { idleStreak: 3 } });
    // allIdle false but concern false + not fruitful → still an all-clear pass
    const [d] = run([a], [outcome({ agentId: 'mon', allIdle: false, anyFruitful: false, concern: false })]);
    expect(d.action?.kind).toBe('downgrade');
  });

  it('never downgrades below the tier floor', () => {
    const a = monitor({ model: 'fast', autopilot: { idleStreak: 3, modelOverride: 'fast' } });
    const [d] = run([a], [outcome({ agentId: 'mon', concern: false, anyFruitful: false })]);
    expect(d.action).toBeUndefined();
  });

  it('restores the tier the moment the monitor finds something', () => {
    const a = monitor({ autopilot: { modelOverride: 'fast', originalModel: 'smart', idleStreak: 2 } });
    const [d] = run([a], [outcome({ agentId: 'mon', anyFruitful: true })]);
    expect(d.action?.kind).toBe('upgrade');
    expect(d.action?.to).toBe('smart');
    expect(d.persistState.modelOverride).toBeUndefined();
    expect(d.persistState.idleStreak).toBe(0);
  });

  it('applies the same downgrade policy to reviewer and planner roles', () => {
    for (const role of ['reviewer', 'planner'] as AgentRole[]) {
      const a = monitor({ id: role, role, autopilot: { idleStreak: 3 } });
      const [d] = run([a], [outcome({ agentId: role, concern: false, anyFruitful: false })]);
      expect(d.action?.kind).toBe('downgrade');
    }
  });
});

describe('decideAutopilot — exemptions', () => {
  it('never touches a publisher', () => {
    const a = makeAgent({ role: 'publisher' });
    expect(run([a], [outcome({ concern: true, concernType: 'loop' })])).toEqual([]);
  });

  it('never touches a system agent', () => {
    const a = makeAgent({ kind: 'system' });
    expect(run([a], [outcome({ concern: true, concernType: 'loop' })])).toEqual([]);
  });

  it('ignores disabled agents and agents without an outcome', () => {
    const disabled = makeAgent({ id: 'd', enabled: false });
    expect(run([disabled], [outcome({ agentId: 'd', concern: true, concernType: 'loop' })])).toEqual([]);
    // agent present but no matching outcome
    expect(run([makeAgent({ id: 'x' })], [outcome({ agentId: 'other' })])).toEqual([]);
  });

  it('skips outcomes that were not analyzed', () => {
    expect(run([makeAgent()], [outcome({ analyzed: false })])).toEqual([]);
  });
});
