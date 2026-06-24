import { describe, it, expect, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import {
  runProducedNoDiff,
  runIsCaughtUp,
  isProjectCaughtUpUnfruitful,
  recentScheduledAgentRuns,
  autoPauseUnfruitfulProjects,
} from '@/lib/orchestrator/unfruitful-pause';

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

describe('autoPauseUnfruitfulProjects', () => {
  const caughtUp = run({ linesAdded: 0, linesRemoved: 0, workSummary: CAUGHT_UP });
  const baseDeps = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    threshold: 3,
    listJobs: () => [caughtUp, caughtUp, caughtUp] as JobData[],
    isAgentJobKind: (k: unknown) => String(k).startsWith('agent:'),
    listProjects: () => [{ name: 'bonker', paused: false }],
    pauseProject: vi.fn().mockResolvedValue(true),
    recommend: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    ...over,
  });

  it('pauses a caught-up project and records a recommendation', async () => {
    const deps = baseDeps();
    const res = await autoPauseUnfruitfulProjects(deps as never);
    expect(res.paused).toEqual(['bonker']);
    expect(deps.pauseProject).toHaveBeenCalledWith('bonker');
    expect(deps.recommend).toHaveBeenCalledTimes(1);
  });

  it('does not count manual agent runs toward the auto-pause threshold', async () => {
    const manualCaughtUp = run({
      linesAdded: 0,
      linesRemoved: 0,
      workSummary: CAUGHT_UP,
      contextMeta: JSON.stringify({ agent: { triggeredBy: 'manual' } }),
    });
    const deps = baseDeps({ listJobs: () => [manualCaughtUp, manualCaughtUp, caughtUp] as JobData[] });
    const res = await autoPauseUnfruitfulProjects(deps as never);
    expect(res.paused).toEqual([]);
    expect(deps.pauseProject).not.toHaveBeenCalled();
  });

  it('uses one qualifying scheduled run when threshold is 0', async () => {
    const deps = baseDeps({ threshold: 0, listJobs: () => [caughtUp] as JobData[] });
    const res = await autoPauseUnfruitfulProjects(deps as never);
    expect(res.paused).toEqual(['bonker']);
    expect(deps.pauseProject).toHaveBeenCalledWith('bonker');
  });

  it('no-ops when disabled', async () => {
    const deps = baseDeps({ enabled: false });
    const res = await autoPauseUnfruitfulProjects(deps as never);
    expect(res.paused).toEqual([]);
    expect(deps.pauseProject).not.toHaveBeenCalled();
  });

  it('skips already-paused projects', async () => {
    const deps = baseDeps({ listProjects: () => [{ name: 'bonker', paused: true }] });
    const res = await autoPauseUnfruitfulProjects(deps as never);
    expect(res.paused).toEqual([]);
    expect(deps.pauseProject).not.toHaveBeenCalled();
  });

  it('does not pause when the project still produces diffs', async () => {
    const fruitful = run({ linesAdded: 5, workSummary: 'work' });
    const deps = baseDeps({ listJobs: () => [fruitful, caughtUp, caughtUp] as JobData[] });
    const res = await autoPauseUnfruitfulProjects(deps as never);
    expect(res.paused).toEqual([]);
    expect(deps.pauseProject).not.toHaveBeenCalled();
  });
});
