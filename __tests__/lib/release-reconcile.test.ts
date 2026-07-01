import { describe, it, expect, beforeEach, vi } from 'vitest';

const startMock = vi.fn();
vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => startMock(...args),
}));

const jobsPausedMock = vi.fn(() => false);
vi.mock('@/lib/shared/job-control', () => ({
  isJobsPaused: () => jobsPausedMock(),
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

const finalizeReleaseJobMock = vi.fn(async (job: import('@/lib/jobs/types').JobData, exit: number) => {
  job.finishedAt = 1;
  job.exitCode = exit;
});
vi.mock('@/lib/jobs/lifecycle', () => ({
  finalizeReleaseJob: (...args: [import('@/lib/jobs/types').JobData, number]) => finalizeReleaseJobMock(...args),
}));

vi.mock('@/lib/jobs/redacted-log-writer', () => ({
  appendRedactedFileSync: vi.fn(),
}));

import {
  MAX_RECONCILE_ATTEMPTS,
  RECONCILE_REARM_COOLDOWN_MS,
  CHILDLESS_RELEASE_QUIET_MS,
  findStalledReleases,
  findChildlessStalledReleases,
  reapChildlessStalledRelease,
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
    for (let i = 0; i < MAX_RECONCILE_ATTEMPTS; i += 1) {
      await reconcileStalledRelease(stalled);
    }
    const capped = await reconcileStalledRelease(stalled);
    expect(capped.status).toBe('attempt_cap');
    expect(capped.attempt).toBe(MAX_RECONCILE_ATTEMPTS + 1);
    expect(startMock).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
    expect(_getReconcileAttemptForTest('rel')).toBe(MAX_RECONCILE_ATTEMPTS);
  });

  it('re-arms the burst budget after the cooldown so a long storm does not strand a recoverable release', async () => {
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
    // Burn the whole burst at a fixed `now` (no re-arm because no time passed).
    for (let i = 0; i < MAX_RECONCILE_ATTEMPTS; i += 1) {
      await reconcileStalledRelease(stalled, NOW);
    }
    const capped = await reconcileStalledRelease(stalled, NOW);
    expect(capped.status).toBe('attempt_cap');
    expect(startMock).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);

    // A capped sweep before the cooldown elapses must NOT re-arm.
    const stillCapped = await reconcileStalledRelease(stalled, NOW + RECONCILE_REARM_COOLDOWN_MS - 1);
    expect(stillCapped.status).toBe('attempt_cap');
    expect(startMock).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);

    // Once the cooldown has elapsed since the last real dispatch, the budget
    // re-arms and the release gets a fresh attempt.
    const reArmed = await reconcileStalledRelease(stalled, NOW + RECONCILE_REARM_COOLDOWN_MS);
    expect(reArmed.status).toBe('redispatched');
    expect(reArmed.attempt).toBe(1);
    expect(startMock).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS + 1);
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

  it('skips re-dispatch (and does not burn attempts) when jobs are paused', async () => {
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
    );
    jobsPausedMock.mockReturnValueOnce(true);
    const out = await runReleaseReconcileSweep(NOW);
    expect(out).toEqual([]);
    expect(startMock).not.toHaveBeenCalled();
    expect(_getReconcileAttemptForTest('rel-a')).toBe(0);
  });
});

const CHILDLESS_QUIET = CHILDLESS_RELEASE_QUIET_MS + 1_000;

describe('findChildlessStalledReleases', () => {
  beforeEach(() => {
    jobs.length = 0;
  });

  it('flags a running release that never started any phase past the quiet period', () => {
    jobs.push(
      makeJob({
        id: 'rel',
        kind: 'release',
        releaseId: 'rel',
        startedAt: (NOW - CHILDLESS_QUIET) / 1000,
        finishedAt: null,
      }),
    );
    const found = findChildlessStalledReleases(NOW);
    expect(found).toHaveLength(1);
    expect(found[0].release.id).toBe('rel');
    expect(found[0].idleMs).toBeGreaterThanOrEqual(CHILDLESS_RELEASE_QUIET_MS);
  });

  it('does NOT flag a childless release still inside the quiet period', () => {
    jobs.push(
      makeJob({
        id: 'rel',
        kind: 'release',
        releaseId: 'rel',
        startedAt: (NOW - 30_000) / 1000,
        finishedAt: null,
      }),
    );
    expect(findChildlessStalledReleases(NOW)).toHaveLength(0);
  });

  it('does NOT flag a release that has any pipeline-step child', () => {
    jobs.push(
      makeJob({
        id: 'rel',
        kind: 'release',
        releaseId: 'rel',
        startedAt: (NOW - CHILDLESS_QUIET) / 1000,
        finishedAt: null,
      }),
      makeJob({ id: 'test-1', kind: 'test', releaseId: 'rel', finishedAt: null }),
    );
    expect(findChildlessStalledReleases(NOW)).toHaveLength(0);
  });

  it('does NOT flag a finished release (e.g. a blocked/queued release row)', () => {
    jobs.push(
      makeJob({
        id: 'rel',
        kind: 'release',
        releaseId: 'rel',
        startedAt: (NOW - CHILDLESS_QUIET) / 1000,
        finishedAt: (NOW - CHILDLESS_QUIET) / 1000,
        exitCode: -3,
      }),
    );
    expect(findChildlessStalledReleases(NOW)).toHaveLength(0);
  });
});

describe('reapChildlessStalledRelease', () => {
  beforeEach(() => {
    jobs.length = 0;
    finalizeReleaseJobMock.mockClear();
  });

  it('finalizes the zombie with exit 1 and stamps a stop reason', async () => {
    const release = makeJob({
      id: 'rel',
      kind: 'release',
      releaseId: 'rel',
      startedAt: (NOW - CHILDLESS_QUIET) / 1000,
      finishedAt: null,
    });
    const out = await reapChildlessStalledRelease({ release, idleMs: CHILDLESS_QUIET });
    expect(out.status).toBe('finalized');
    expect(finalizeReleaseJobMock).toHaveBeenCalledWith(release, 1);
    const meta = JSON.parse(release.contextMeta as string);
    expect(meta.releaseStopReason).toMatch(/no pipeline phase started/);
  });

  it('reports finalize_failed when finalization throws', async () => {
    finalizeReleaseJobMock.mockRejectedValueOnce(new Error('db down'));
    const release = makeJob({ id: 'rel', kind: 'release', releaseId: 'rel', finishedAt: null });
    const out = await reapChildlessStalledRelease({ release, idleMs: CHILDLESS_QUIET });
    expect(out.status).toBe('finalize_failed');
    expect(out.error).toContain('db down');
  });
});

describe('runReleaseReconcileSweep — childless zombie reap', () => {
  beforeEach(() => {
    jobs.length = 0;
    _resetReconcileAttemptsForTest();
    finalizeReleaseJobMock.mockClear();
    startMock.mockReset().mockResolvedValue({ runId: 'wrun_recover' });
  });

  it('finalizes a childless zombie release during the sweep', async () => {
    jobs.push(
      makeJob({
        id: 'rel',
        kind: 'release',
        releaseId: 'rel',
        startedAt: (NOW - CHILDLESS_QUIET) / 1000,
        finishedAt: null,
      }),
    );
    await runReleaseReconcileSweep(NOW);
    expect(finalizeReleaseJobMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'rel' }), 1);
  });

  it('reaps the childless zombie even when jobs are paused', async () => {
    jobs.push(
      makeJob({
        id: 'rel',
        kind: 'release',
        releaseId: 'rel',
        startedAt: (NOW - CHILDLESS_QUIET) / 1000,
        finishedAt: null,
      }),
    );
    jobsPausedMock.mockReturnValueOnce(true);
    const out = await runReleaseReconcileSweep(NOW);
    expect(out).toEqual([]);
    expect(finalizeReleaseJobMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'rel' }), 1);
  });
});
