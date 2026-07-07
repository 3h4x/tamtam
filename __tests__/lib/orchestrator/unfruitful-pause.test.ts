import { describe, it, expect, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import {
  runProducedNoDiff,
  runIsCaughtUp,
  runDispatchedAction,
  runWasProductive,
  runIsExternallyGated,
  isProjectCaughtUpUnfruitful,
  isProjectPersistentlyUnfruitful,
  unfruitfulRateSample,
  recentScheduledAgentRuns,
  autoDisableUnfruitfulAgents,
} from '@/lib/orchestrator/unfruitful-pause';
import type { AgentRole } from '@/lib/agents/roles';

function run(over: Partial<JobData> = {}): JobData {
  return {
    id: over.id ?? 'j',
    project: over.project ?? 'bonker',
    kind: over.kind ?? 'agent:refactor-split',
    contextMeta: JSON.stringify({ agent: { triggeredBy: 'schedule' } }),
    pid: 1,
    logPath: null,
    startedAt: over.startedAt ?? 100,
    finishedAt: over.finishedAt ?? 200,
    exitCode: over.exitCode ?? 0,
    seen: false,
    ...over,
  } as JobData;
}

const CAUGHT_UP = 'Prerequisite found no eligible oversized split target';

/** A 0-diff scheduled run that dispatched `executed` server-side agent actions
 *  (e.g. merged a PR / closed an issue) — productive triage with no code diff. */
function triage(executed = 1, over: Partial<JobData> = {}): JobData {
  return run({
    linesAdded: 0,
    linesRemoved: 0,
    exitCode: 0,
    workSummary: 'Verified acceptance criteria and merged the open PR',
    contextMeta: JSON.stringify({ agent: { triggeredBy: 'schedule' }, agentActions: { executed } }),
    ...over,
  });
}

describe('runProducedNoDiff', () => {
  it('true when zero lines and no modified files', () => {
    expect(runProducedNoDiff(run({ linesAdded: 0, linesRemoved: 0, modifiedFiles: null }))).toBe(true);
    expect(runProducedNoDiff(run({ linesAdded: 0, linesRemoved: 0, modifiedFiles: '[]' }))).toBe(true);
  });
  it('false when any lines changed or files touched', () => {
    expect(runProducedNoDiff(run({ linesAdded: 3 }))).toBe(false);
    expect(runProducedNoDiff(run({ linesRemoved: 1 }))).toBe(false);
    expect(runProducedNoDiff(run({ modifiedFiles: 'src/x.ts' }))).toBe(false);
  });
});

describe('runIsCaughtUp', () => {
  it('matches "no eligible ... target" and other nothing-to-do phrasings', () => {
    expect(runIsCaughtUp(run({ workSummary: CAUGHT_UP }))).toBe(true);
    expect(runIsCaughtUp(run({ workSummary: 'nothing to do' }))).toBe(true);
    expect(runIsCaughtUp(run({ workSummary: 'refactored 4 files' }))).toBe(false);
    expect(runIsCaughtUp(run({ workSummary: null }))).toBe(false);
  });
});

describe('runDispatchedAction', () => {
  it('true when the run dispatched ≥1 server-side agent action', () => {
    expect(runDispatchedAction(triage(1))).toBe(true);
    expect(runDispatchedAction(triage(3))).toBe(true);
  });
  it('false when no action was dispatched (0, absent, or no agentActions meta)', () => {
    expect(runDispatchedAction(triage(0))).toBe(false);
    expect(runDispatchedAction(run({ workSummary: CAUGHT_UP }))).toBe(false); // no agentActions key
    expect(runDispatchedAction(run({ contextMeta: null }))).toBe(false);
    expect(runDispatchedAction(run({ contextMeta: '{' }))).toBe(false); // malformed
  });
});

describe('runWasProductive', () => {
  it('true for a line-level change', () => {
    expect(runWasProductive(run({ linesAdded: 5 }))).toBe(true);
  });
  it('true for a 0-diff run that dispatched a triage action (merge/close)', () => {
    expect(runWasProductive(triage(1))).toBe(true);
  });
  it('false when neither lines changed nor an action dispatched', () => {
    expect(runWasProductive(run({ linesAdded: 0, linesRemoved: 0, workSummary: CAUGHT_UP }))).toBe(false);
  });
});

describe('isProjectCaughtUpUnfruitful', () => {
  const noDiffCaughtUp = run({ linesAdded: 0, linesRemoved: 0, workSummary: CAUGHT_UP });
  const noDiffFail = run({ linesAdded: 0, linesRemoved: 0, exitCode: -1, workSummary: null });
  const fruitful = run({ linesAdded: 10, workSummary: 'did work' });

  it('true when all N runs are no-diff and at least one is caught up', () => {
    const runs = [noDiffCaughtUp, noDiffFail, noDiffCaughtUp, noDiffFail, noDiffCaughtUp];
    expect(isProjectCaughtUpUnfruitful(runs, 5)).toBe(true);
  });
  it('false when fewer than N finished runs are available', () => {
    expect(isProjectCaughtUpUnfruitful([noDiffCaughtUp, noDiffCaughtUp], 5)).toBe(false);
  });
  it('false when a fruitful run is inside the window (still has work)', () => {
    const runs = [noDiffCaughtUp, fruitful, noDiffCaughtUp, noDiffCaughtUp, noDiffCaughtUp];
    expect(isProjectCaughtUpUnfruitful(runs, 5)).toBe(false);
  });
  it('false when all no-diff but NONE reports caught up (transient failures, needs attention not silencing)', () => {
    const runs = [noDiffFail, noDiffFail, noDiffFail, noDiffFail, noDiffFail];
    expect(isProjectCaughtUpUnfruitful(runs, 5)).toBe(false);
  });
  it('true for clean exit-0 no-diff runs whose summary is not a known nothing-to-do phrase (blog-writer "found no material")', () => {
    const cleanNoop = run({
      linesAdded: 0,
      linesRemoved: 0,
      exitCode: 0,
      workSummary: 'Fetched live stats/trending data, found no material',
    });
    expect(isProjectCaughtUpUnfruitful([cleanNoop, cleanNoop, cleanNoop, cleanNoop, cleanNoop], 5)).toBe(true);
  });
  it('treats threshold 0 as one qualifying run', () => {
    expect(isProjectCaughtUpUnfruitful([noDiffCaughtUp], 0)).toBe(true);
    expect(isProjectCaughtUpUnfruitful([fruitful], 0)).toBe(false);
  });
  it('false when a 0-diff run in the window dispatched a triage action (merged/closed → not caught up)', () => {
    // A backlog-draining issue-cruncher merges/closes with zero code diff.
    // Those runs must NOT read as "caught up / nothing to do".
    const runs = [triage(1), noDiffCaughtUp, noDiffCaughtUp, noDiffCaughtUp, noDiffCaughtUp];
    expect(isProjectCaughtUpUnfruitful(runs, 5)).toBe(false);
  });
});

describe('isProjectPersistentlyUnfruitful', () => {
  const noDiffCaughtUp = run({ linesAdded: 0, linesRemoved: 0, workSummary: CAUGHT_UP });
  const noDiffFail = run({ linesAdded: 0, linesRemoved: 0, exitCode: -1, workSummary: null });
  const fruitful = run({ linesAdded: 10, workSummary: 'did work' });
  // 10-run window: 1 fruitful, 9 no-diff (one caught up) = 10% < 20% floor.
  const lowRateWindow = [fruitful, ...Array(9).fill(noDiffCaughtUp)] as JobData[];

  it('pauses on a low fruitful rate over the sample even without an all-no-diff window', () => {
    expect(isProjectPersistentlyUnfruitful(lowRateWindow, 10, 0.2)).toBe(true);
    // The strict caught-up check rejects it (a fruitful run is in the window).
    expect(isProjectCaughtUpUnfruitful(lowRateWindow, 10)).toBe(false);
  });
  it('does not pause when the rate is at/above the floor', () => {
    // 3 fruitful of 10 = 30% >= 20%.
    const ok = [fruitful, fruitful, fruitful, ...Array(7).fill(noDiffCaughtUp)] as JobData[];
    expect(isProjectPersistentlyUnfruitful(ok, 10, 0.2)).toBe(false);
  });
  it('does not pause with fewer runs than the sample', () => {
    expect(isProjectPersistentlyUnfruitful([noDiffCaughtUp, noDiffCaughtUp], 10, 0.2)).toBe(false);
  });
  it('does not pause a low-rate window that is only crashing (no clean run)', () => {
    const allFail = Array(10).fill(noDiffFail) as JobData[];
    expect(isProjectPersistentlyUnfruitful(allFail, 10, 0.2)).toBe(false);
  });
  it('rateThreshold 0 disables the rate trigger', () => {
    expect(isProjectPersistentlyUnfruitful(lowRateWindow, 10, 0)).toBe(false);
  });
  it('counts a run that touches files but moves zero lines as unproductive (0-line no-op churn)', () => {
    // Agent re-touches the same file every run but the net line delta is 0 —
    // looks "fruitful" to runProducedNoDiff (files set) but lands nothing.
    const fileTouchNoLines = run({
      linesAdded: 0,
      linesRemoved: 0,
      modifiedFiles: '[{"path":"app/x/page.tsx"}]',
      exitCode: 0,
      workSummary: 'rewrote page',
    });
    const realChange = run({ linesAdded: 12, modifiedFiles: '[{"path":"app/y.ts"}]' });
    const window = [realChange, ...Array(11).fill(fileTouchNoLines)] as JobData[]; // 1/12 line-fruitful
    expect(isProjectPersistentlyUnfruitful(window, 12, 0.2)).toBe(true);
  });
  it('credits 0-diff triage runs (merge/close) as fruitful so a backlog-draining cruncher is not paused', () => {
    // A cruncher that merges ready PRs / closes done issues lands ZERO code
    // lines but is doing exactly its job. Every run dispatched an action, so
    // the fruitful rate is 100% and the project must NOT be flagged.
    const window = Array(12).fill(triage(1)) as JobData[];
    expect(isProjectPersistentlyUnfruitful(window, 12, 0.2)).toBe(false);
  });
  it('clears the floor when diffless-but-productive triage runs push the rate above 20%', () => {
    // 12 runs: 3 triage merges (0 diff, action dispatched) + 9 genuine no-ops.
    // By lines alone that is 0% fruitful (would pause); crediting the merges
    // makes it 25% ≥ 20% floor → not paused.
    const window = [triage(1), triage(2), triage(1), ...Array(9).fill(noDiffCaughtUp)] as JobData[];
    expect(isProjectPersistentlyUnfruitful(window, 12, 0.2)).toBe(false);
  });
  it('still pauses a genuinely idle project whose diffless runs dispatched NO actions', () => {
    // No agentActions on any run (found nothing to do) → not credited → paused.
    const window = Array(12).fill(noDiffCaughtUp) as JobData[];
    expect(isProjectPersistentlyUnfruitful(window, 12, 0.2)).toBe(true);
  });
  it('unfruitfulRateSample widens the window past the strict threshold', () => {
    expect(unfruitfulRateSample(3)).toBe(10);
    expect(unfruitfulRateSample(8)).toBe(16);
  });
});

describe('recentScheduledAgentRuns', () => {
  it('filters to finished scheduled agent runs for the project, newest-first', () => {
    const jobs = [
      run({ id: 'a', startedAt: 10 }),
      run({ id: 'b', startedAt: 30 }),
      run({ id: 'release', kind: 'release', startedAt: 40 }),
      run({ id: 'other', project: 'seo-tools', startedAt: 50 }),
      run({ id: 'running', startedAt: 60, finishedAt: null }),
      run({ id: 'manual', startedAt: 70, contextMeta: JSON.stringify({ agent: { triggeredBy: 'manual' } }) }),
      run({ id: 'initiative', startedAt: 80, contextMeta: JSON.stringify({ agent: { triggeredBy: 'initiative' } }) }),
      run({ id: 'missing-meta', startedAt: 90, contextMeta: null }),
      run({ id: 'malformed-meta', startedAt: 100, contextMeta: '{' }),
    ];
    const out = recentScheduledAgentRuns(jobs, 'bonker', (k) => String(k).startsWith('agent:'), 10);
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('runIsExternallyGated', () => {
  it('true when the run targeted a GitHub issue/PR', () => {
    expect(runIsExternallyGated(run({ ghIssueNumber: 42 }))).toBe(true);
  });
  it('true when the run dispatched a server-side triage action (merge/close)', () => {
    expect(runIsExternallyGated(triage(1))).toBe(true);
  });
  it('false for a plain no-diff run with no issue link and no action', () => {
    expect(runIsExternallyGated(run({ ghIssueNumber: null, workSummary: CAUGHT_UP }))).toBe(false);
  });
});

describe('autoDisableUnfruitfulAgents', () => {
  // Default fixture runs carry kind `agent:refactor-split`, matching the
  // producer agent below so recentScheduled lookups resolve to it.
  const caughtUp = run({ linesAdded: 0, linesRemoved: 0, workSummary: CAUGHT_UP });
  const producer = (over: Record<string, unknown> = {}) => ({
    id: 'a-refactor',
    name: 'refactor-split',
    project: 'proj',
    role: 'producer' as AgentRole,
    kind: 'user' as const,
    enabled: true,
    ...over,
  });
  const baseDeps = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    threshold: 3,
    rateThreshold: 0.2,
    listJobs: () => [caughtUp, caughtUp, caughtUp] as JobData[],
    isAgentJobKind: (k: unknown) => String(k).startsWith('agent:'),
    getJobKind: (k: unknown) => (typeof k === 'string' ? k : ''),
    listAgents: () => [producer()],
    disableAgent: vi.fn().mockResolvedValue(true),
    recommend: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    ...over,
  });

  it('disables a caught-up producer agent and records a per-agent recommendation', async () => {
    const deps = baseDeps();
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual(['refactor-split']);
    expect(deps.disableAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a-refactor', name: 'refactor-split', project: 'proj' }),
    );
    expect(deps.recommend).toHaveBeenCalledTimes(1);
    const call = deps.recommend.mock.calls[0][0];
    expect(call.agentName).toBe('refactor-split');
    // The disable already happened: the recommendation is a completed-action
    // record, so it is created `resolved` (archives to History, out of the
    // decision queue) and carries `enabled:false` so the Fix menu never offers
    // Run/Disable on an already-disabled agent.
    expect(call.status).toBe('resolved');
    expect(call.payload).toEqual({ enabled: false });
  });

  it('disables a persistently-unfruitful producer with a rate-reason recommendation', async () => {
    const oneFruitful = run({ linesAdded: 8, workSummary: 'did a thing' });
    // 10 scheduled runs, 1 fruitful = 10% < 20% floor; no all-no-diff window.
    const jobs = [oneFruitful, ...Array(9).fill(caughtUp)] as JobData[];
    const recommend = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ listJobs: () => jobs, recommend });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual(['refactor-split']);
    const call = recommend.mock.calls[0][0];
    expect(call.title).toMatch(/persistently unfruitful/i);
    expect(call.status).toBe('resolved');
    expect(call.payload).toEqual({ enabled: false });
  });

  it('never disables a non-producer agent (idle is by-design for publisher/monitor/reviewer/planner)', async () => {
    const deps = baseDeps({ listAgents: () => [producer({ role: 'publisher' })] });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
    expect(deps.disableAgent).not.toHaveBeenCalled();
  });

  it('never disables a system agent', async () => {
    const deps = baseDeps({ listAgents: () => [producer({ kind: 'system' })] });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
  });

  it('never disables an externally-gated producer (issue-cruncher waiting on a GitHub backlog)', async () => {
    // A producer-role cruncher whose recent runs target issues: a no-diff
    // stretch means "no open work right now", not waste.
    const issueRuns = Array(6).fill(
      run({ kind: 'agent:issue-cruncher', ghIssueNumber: 7, linesAdded: 0, linesRemoved: 0, workSummary: CAUGHT_UP }),
    ) as JobData[];
    const deps = baseDeps({
      listJobs: () => issueRuns,
      listAgents: () => [producer({ id: 'a-ic', name: 'issue-cruncher' })],
    });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
    expect(deps.disableAgent).not.toHaveBeenCalled();
  });

  it('does not disable a producer with fewer scheduled runs than the threshold', async () => {
    const deps = baseDeps({ listJobs: () => [caughtUp, caughtUp] as JobData[] }); // 2 < threshold 3
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
  });

  it('does not disable a producer still producing diffs above the rate floor', async () => {
    const fruitful = run({ linesAdded: 8 });
    const jobs = [fruitful, fruitful, fruitful, ...Array(7).fill(caughtUp)] as JobData[]; // 30%
    const deps = baseDeps({ listJobs: () => jobs });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
  });

  it('ignores manual (non-scheduled) runs when judging an agent', async () => {
    const manual = run({
      workSummary: CAUGHT_UP,
      contextMeta: JSON.stringify({ agent: { triggeredBy: 'manual' } }),
    });
    const deps = baseDeps({ listJobs: () => [manual, manual, manual] as JobData[] });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
  });

  it('no-ops when disabled', async () => {
    const deps = baseDeps({ enabled: false });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
    expect(deps.disableAgent).not.toHaveBeenCalled();
  });

  it('skips agents whose project is not active (paused or archived)', async () => {
    const deps = baseDeps({ isProjectActive: () => false });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
    expect(deps.disableAgent).not.toHaveBeenCalled();
  });

  it('skips an already-disabled agent', async () => {
    const deps = baseDeps({ listAgents: () => [producer({ enabled: false })] });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
  });

  it('does not record a recommendation when the disable write fails', async () => {
    const deps = baseDeps({ disableAgent: vi.fn().mockResolvedValue(false) });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual([]);
    expect(deps.recommend).not.toHaveBeenCalled();
  });

  it('only disables the unfruitful producer, leaving a fruitful sibling agent enabled', async () => {
    // Two producers in one project: one caught up, one shipping diffs. Only the
    // caught-up one is disabled — the project itself is never touched.
    const idleRuns = Array(3).fill(run({ kind: 'agent:refactor-split', workSummary: CAUGHT_UP })) as JobData[];
    const busyRuns = Array(3).fill(run({ kind: 'agent:feature-builder', linesAdded: 20 })) as JobData[];
    const disableAgent = vi.fn().mockResolvedValue(true);
    const deps = baseDeps({
      listJobs: () => [...idleRuns, ...busyRuns] as JobData[],
      listAgents: () => [
        producer(),
        producer({ id: 'a-feat', name: 'feature-builder' }),
      ],
      disableAgent,
    });
    const res = await autoDisableUnfruitfulAgents(deps as never);
    expect(res.disabled).toEqual(['refactor-split']);
    expect(disableAgent).toHaveBeenCalledTimes(1);
    expect(disableAgent).toHaveBeenCalledWith(expect.objectContaining({ name: 'refactor-split' }));
  });
});
