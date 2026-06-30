import { describe, it, expect } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import {
  agentRunBaselineHead,
  isAgentSaturated,
  recentScheduledRunsForAgent,
} from '@/lib/orchestrator/agent-saturation';

function run(overrides: Partial<JobData> = {}): JobData {
  return {
    id: `job-${Math.round((overrides.startedAt ?? 0) * 1000)}`,
    project: 'proj1',
    kind: 'agent:refactor-ui',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 1000,
    finishedAt: 1100,
    exitCode: 0,
    seen: false,
    abortedAt: null,
    linesAdded: 0,
    linesRemoved: 0,
    modifiedFiles: '[]',
    contextMeta: JSON.stringify({ agent: { triggeredBy: 'schedule' }, baseline: { head: 'HEAD_A' } }),
    ...overrides,
  } as JobData;
}

describe('agentRunBaselineHead', () => {
  it('extracts contextMeta.baseline.head', () => {
    expect(agentRunBaselineHead(run({ contextMeta: JSON.stringify({ baseline: { head: 'abc123' } }) }))).toBe('abc123');
  });
  it('returns null for missing/empty/unparseable head', () => {
    expect(agentRunBaselineHead(run({ contextMeta: null }))).toBeNull();
    expect(agentRunBaselineHead(run({ contextMeta: '{bad json' }))).toBeNull();
    expect(agentRunBaselineHead(run({ contextMeta: JSON.stringify({ baseline: { head: '' } }) }))).toBeNull();
    expect(agentRunBaselineHead(run({ contextMeta: JSON.stringify({}) }))).toBeNull();
  });
});

describe('isAgentSaturated', () => {
  const SAMPLE = 4;
  const RATE = 0.2;

  function noDiffRun(head: string): JobData {
    return run({ linesAdded: 0, linesRemoved: 0, modifiedFiles: '[]', exitCode: 0, contextMeta: JSON.stringify({ baseline: { head } }) });
  }
  function fruitfulRun(head: string): JobData {
    return run({ linesAdded: 5, linesRemoved: 1, modifiedFiles: '[{"path":"x"}]', exitCode: 0, contextMeta: JSON.stringify({ baseline: { head } }) });
  }

  it('is saturated: all-no-diff window, low rate, HEAD unchanged since last run', () => {
    const runs = [noDiffRun('HEAD_X'), noDiffRun('HEAD_X'), noDiffRun('HEAD_W'), noDiffRun('HEAD_V')];
    expect(isAgentSaturated(runs, 'HEAD_X', SAMPLE, RATE)).toBe(true);
  });

  it('NOT saturated when HEAD has moved since the last run (release valve)', () => {
    const runs = [noDiffRun('HEAD_X'), noDiffRun('HEAD_X'), noDiffRun('HEAD_W'), noDiffRun('HEAD_V')];
    expect(isAgentSaturated(runs, 'HEAD_NEW', SAMPLE, RATE)).toBe(false);
  });

  it('NOT saturated when the fruitful rate is at/above threshold', () => {
    // 1 fruitful of 4 = 0.25 >= 0.2
    const runs = [noDiffRun('HEAD_X'), fruitfulRun('HEAD_X'), noDiffRun('HEAD_W'), noDiffRun('HEAD_V')];
    expect(isAgentSaturated(runs, 'HEAD_X', SAMPLE, RATE)).toBe(false);
  });

  it('NOT saturated without enough history', () => {
    const runs = [noDiffRun('HEAD_X'), noDiffRun('HEAD_X')];
    expect(isAgentSaturated(runs, 'HEAD_X', SAMPLE, RATE)).toBe(false);
  });

  it('NOT saturated on a pure crash streak (no clean completion) — needs attention, not silencing', () => {
    const crash = (head: string) => run({ linesAdded: 0, linesRemoved: 0, modifiedFiles: '[]', exitCode: -1, contextMeta: JSON.stringify({ baseline: { head } }) });
    const runs = [crash('HEAD_X'), crash('HEAD_X'), crash('HEAD_W'), crash('HEAD_V')];
    expect(isAgentSaturated(runs, 'HEAD_X', SAMPLE, RATE)).toBe(false);
  });

  it('NOT saturated when currentHead is unknown (null) — never silence blind', () => {
    const runs = [noDiffRun('HEAD_X'), noDiffRun('HEAD_X'), noDiffRun('HEAD_W'), noDiffRun('HEAD_V')];
    expect(isAgentSaturated(runs, null, SAMPLE, RATE)).toBe(false);
  });

  it('disabled when rateThreshold <= 0', () => {
    const runs = [noDiffRun('HEAD_X'), noDiffRun('HEAD_X'), noDiffRun('HEAD_W'), noDiffRun('HEAD_V')];
    expect(isAgentSaturated(runs, 'HEAD_X', SAMPLE, 0)).toBe(false);
  });
});

describe('recentScheduledRunsForAgent', () => {
  const getJobKind = (k: unknown) => String(k);
  const isAgentJobKind = (k: unknown) => String(k).startsWith('agent:');

  it('filters to one agent kind, scheduled + finished, newest-first', () => {
    const jobs: JobData[] = [
      run({ kind: 'agent:refactor-ui', startedAt: 300 }),
      run({ kind: 'agent:improve', startedAt: 290 }), // other agent
      run({ kind: 'agent:refactor-ui', startedAt: 280 }),
      run({ kind: 'agent:refactor-ui', startedAt: 270, finishedAt: null }), // running
      run({ kind: 'agent:refactor-ui', startedAt: 260, contextMeta: JSON.stringify({ agent: { triggeredBy: 'manual' }, baseline: { head: 'H' } }) }), // manual
      run({ kind: 'release', startedAt: 250 }), // not an agent
    ];
    const out = recentScheduledRunsForAgent(jobs, 'proj1', 'agent:refactor-ui', isAgentJobKind, getJobKind, 10);
    expect(out.map((j) => j.startedAt)).toEqual([300, 280]);
  });
});
