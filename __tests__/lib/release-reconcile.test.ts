import { describe, it, expect, beforeEach, vi } from 'vitest';

const startMock = vi.fn();
vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => startMock(...args),
}));

const orchestratorFn = vi.fn();
vi.mock('@/lib/workflows/release-orchestrator', () => ({
  releaseOrchestratorWorkflow: orchestratorFn,
}));

const jobs: import('@/lib/jobs/types').JobData[] = [];
vi.mock('@/lib/jobs/job-storage', () => ({
  listJobs: () => jobs,
  getJob: (id: string) => jobs.find((j) => j.id === id) ?? null,
  PIPELINE_STEP_KINDS: new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod']),
}));

import {
  findStalledReleases,
  reconcileStalledRelease,
  runReleaseReconcileSweep,
  _resetReconcileAttemptsForTest,
  _getReconcileAttemptForTest,
} from '@/lib/jobs/release-reconcile';
import type { JobData } from '@/lib/jobs/types';

function makeJob(o: Partial<JobData> & Pick<JobData, 'id' | 'kind'>): JobData {
  return {
    project: 'p',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...o,
  } as JobData;
}

const NOW = 2_000_000_000_000; // arbitrary fixed `now`
const QUIET = 91_000; // > 90s quiet period

describe('findStalledReleases', () => {
  beforeEach(() => {
    jobs.length = 0;
    _resetReconcileAttemptsForTest();
  });

  it('flags a release with all children terminal and quiet period elapsed', () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', startedAt: 1, finishedAt: null }),
      makeJob({
        id: 'fix-1',
        kind: 'fix',
        releaseId: 'rel',
        startedAt: 1,
        finishedAt: (NOW - QUIET) / 1000,
        exitCode: -1,
      }),
    );
    const stalled = findStalledReleases(NOW);
    expect(stalled).toHaveLength(1);
    expect(stalled[0].latestTerminalChild.id).toBe('fix-1');
    expect(stalled[0].idleMs).toBeGreaterThanOrEqual(QUIET);
  });

  it('skips when a child is still running', () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: null }),
      makeJob({ id: 'fix-1', kind: 'fix', releaseId: 'rel', finishedAt: (NOW - QUIET) / 1000, exitCode: -1 }),
      makeJob({ id: 'rev-1', kind: 'review', releaseId: 'rel', finishedAt: null }),
    );
    expect(findStalledReleases(NOW)).toHaveLength(0);
  });

  it('skips when quiet period has not elapsed', () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: null }),
      makeJob({ id: 'fix-1', kind: 'fix', releaseId: 'rel', finishedAt: (NOW - 30_000) / 1000, exitCode: 0 }),
    );
    expect(findStalledReleases(NOW)).toHaveLength(0);
  });

  it('skips releases with no pipeline children', () => {
    jobs.push(makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: null }));
    expect(findStalledReleases(NOW)).toHaveLength(0);
  });

  it('skips releases that already finalized', () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: NOW / 1000 }),
      makeJob({ id: 'fix-1', kind: 'fix', releaseId: 'rel', finishedAt: (NOW - QUIET) / 1000, exitCode: -1 }),
    );
    expect(findStalledReleases(NOW)).toHaveLength(0);
  });

  it('picks the most-recent terminal child as the dispatch anchor', () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: null }),
      makeJob({ id: 'rev-1', kind: 'review', releaseId: 'rel', finishedAt: (NOW - 200_000) / 1000, exitCode: 0 }),
      makeJob({ id: 'fix-1', kind: 'fix', releaseId: 'rel', finishedAt: (NOW - QUIET) / 1000, exitCode: -1 }),
    );
    const stalled = findStalledReleases(NOW);
    expect(stalled[0].latestTerminalChild.id).toBe('fix-1');
  });
});

describe('reconcileStalledRelease', () => {
  beforeEach(() => {
    jobs.length = 0;
    _resetReconcileAttemptsForTest();
    startMock.mockReset().mockResolvedValue({ runId: 'wrun_recover' });
  });

  it('re-dispatches the orchestrator for the latest terminal child', async () => {
    jobs.push(
      makeJob({ id: 'rel', project: 'demo', kind: 'release', releaseId: 'rel', finishedAt: null }),
      makeJob({
        id: 'fix-1',
        project: 'demo',
        kind: 'fix',
        releaseId: 'rel',
        finishedAt: (NOW - QUIET) / 1000,
        exitCode: -1,
      }),
    );
    const [stalled] = findStalledReleases(NOW);
    const outcome = await reconcileStalledRelease(stalled);
    expect(outcome.status).toBe('redispatched');
    expect(outcome.attempt).toBe(1);
    expect(startMock).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledWith(orchestratorFn, [
      'fix-1',
      { projectName: 'demo', parentJobId: 'rel' },
    ]);
  });

  it('caps attempts at MAX_RECONCILE_ATTEMPTS', async () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: null }),
      makeJob({
        id: 'fix-1',
        kind: 'fix',
        releaseId: 'rel',
        finishedAt: (NOW - QUIET) / 1000,
        exitCode: -1,
      }),
    );
    const [stalled] = findStalledReleases(NOW);
    await reconcileStalledRelease(stalled);
    await reconcileStalledRelease(stalled);
    await reconcileStalledRelease(stalled);
    const fourth = await reconcileStalledRelease(stalled);
    expect(fourth.status).toBe('attempt_cap');
    expect(startMock).toHaveBeenCalledTimes(3);
    expect(_getReconcileAttemptForTest('rel')).toBe(3);
  });

  it('reports dispatch_failed when start() throws', async () => {
    jobs.push(
      makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: null }),
      makeJob({
        id: 'fix-1',
        kind: 'fix',
        releaseId: 'rel',
        finishedAt: (NOW - QUIET) / 1000,
        exitCode: -1,
      }),
    );
    startMock.mockRejectedValueOnce(new Error('queue down'));
    const [stalled] = findStalledReleases(NOW);
    const outcome = await reconcileStalledRelease(stalled);
    expect(outcome.status).toBe('dispatch_failed');
    expect(outcome.error).toBe('queue down');
  });
});

describe('runReleaseReconcileSweep', () => {
  beforeEach(() => {
    jobs.length = 0;
    _resetReconcileAttemptsForTest();
    startMock.mockReset().mockResolvedValue({ runId: 'wrun_recover' });
  });

  it('returns one outcome per stalled release', async () => {
    jobs.push(
      makeJob({ id: 'rel-a', project: 'a', kind: 'release', releaseId: 'rel-a', finishedAt: null }),
      makeJob({
        id: 'a-fix',
        project: 'a',
        kind: 'fix',
        releaseId: 'rel-a',
        finishedAt: (NOW - QUIET) / 1000,
        exitCode: -1,
      }),
      makeJob({ id: 'rel-b', project: 'b', kind: 'release', releaseId: 'rel-b', finishedAt: null }),
      makeJob({
        id: 'b-fix',
        project: 'b',
        kind: 'fix',
        releaseId: 'rel-b',
        finishedAt: (NOW - QUIET) / 1000,
        exitCode: -1,
      }),
    );
    const out = await runReleaseReconcileSweep(NOW);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.status)).toEqual(['redispatched', 'redispatched']);
  });

  it('returns empty when no releases are stalled', async () => {
    const out = await runReleaseReconcileSweep(NOW);
    expect(out).toEqual([]);
  });
});
