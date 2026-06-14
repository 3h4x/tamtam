import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobData } from '@/lib/jobs/types';
import {
  TEST_JOB_TIMEOUT_MS,
  TEST_TIMEOUT_EXIT_CODE,
  findTimedOutTestJobs,
  killJobProcessGroup,
  reapTimedOutTestJobs,
} from '@/lib/jobs/test-timeout-reaper';

// reapTimedOutTestJobs reads jobs and finalizes them through job-storage; stub
// both so we can drive the full reap path with a real (killable) process.
const reapState = vi.hoisted(() => ({ jobs: [] as JobData[], done: [] as Array<{ id: string; code: number }> }));
vi.mock('@/lib/jobs/job-storage', () => ({
  listJobs: () => reapState.jobs,
  markDone: async (job: JobData, code: number) => {
    reapState.done.push({ id: job.id, code });
    (job as { finishedAt: number | null }).finishedAt = 1;
  },
}));

// startedAt is stored in SECONDS (see createJob in lib/jobs/storage.ts and
// the age math in lib/jobs/probe.ts). Build minimal job rows for the pure
// decision function.
function mkJob(partial: Partial<JobData>): JobData {
  return {
    id: 'job-x',
    kind: 'test',
    project: 'demo',
    pid: 1234,
    logPath: null,
    startedAt: 0,
    finishedAt: null,
    ...partial,
  } as unknown as JobData;
}

const NOW_MS = 1_000_000_000_000; // fixed clock for determinism (ms)
const NOW_SEC = NOW_MS / 1000;
const OVER = NOW_SEC - (TEST_JOB_TIMEOUT_MS / 1000) - 60; // 1 min past the cap
const RECENT = NOW_SEC - 60; // 1 min ago

describe('findTimedOutTestJobs', () => {
  it('returns a running test job that blew past the wall-clock cap', () => {
    const job = mkJob({ id: 'old', kind: 'test', pid: 4242, startedAt: OVER, finishedAt: null });
    const out = findTimedOutTestJobs([job], NOW_MS);
    expect(out.map((j) => j.id)).toEqual(['old']);
  });

  it('excludes a test job still within the cap', () => {
    const job = mkJob({ id: 'young', kind: 'test', pid: 4242, startedAt: RECENT, finishedAt: null });
    expect(findTimedOutTestJobs([job], NOW_MS)).toEqual([]);
  });

  it('excludes an already-finished test job', () => {
    const job = mkJob({ id: 'done', kind: 'test', pid: 4242, startedAt: OVER, finishedAt: NOW_SEC });
    expect(findTimedOutTestJobs([job], NOW_MS)).toEqual([]);
  });

  it('excludes non-test jobs (e.g. release) even when old', () => {
    const job = mkJob({ id: 'rel', kind: 'release', pid: 4242, startedAt: OVER, finishedAt: null });
    expect(findTimedOutTestJobs([job], NOW_MS)).toEqual([]);
  });

  it('excludes jobs without a real pid (pid <= 0)', () => {
    const job = mkJob({ id: 'nopid', kind: 'test', pid: 0, startedAt: OVER, finishedAt: null });
    expect(findTimedOutTestJobs([job], NOW_MS)).toEqual([]);
  });
});

describe('killJobProcessGroup', () => {
  const spawned: ChildProcess[] = [];
  afterEach(() => {
    for (const c of spawned) {
      if (c.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} try { process.kill(c.pid, 'SIGKILL'); } catch {} }
    }
    spawned.length = 0;
    vi.restoreAllMocks();
  });

  it('SIGTERMs the whole process group of a detached child', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    spawned.push(child);
    expect(child.pid).toBeGreaterThan(0);
    // alive before
    expect(() => process.kill(child.pid!, 0)).not.toThrow();

    killJobProcessGroup(child.pid!, 200);

    // poll until dead (SIGTERM reaps `sleep` promptly)
    const deadline = Date.now() + 3000;
    let dead = false;
    while (Date.now() < deadline) {
      try { process.kill(child.pid!, 0); } catch { dead = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(dead).toBe(true);
  });

  it('refuses to signal dangerous pids (<= 1) — never the caller\'s own group', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    killJobProcessGroup(0);
    killJobProcessGroup(1);
    killJobProcessGroup(process.pid);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('reapTimedOutTestJobs (end-to-end)', () => {
  const spawned: ChildProcess[] = [];
  afterEach(() => {
    for (const c of spawned) {
      if (c.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} }
    }
    spawned.length = 0;
    reapState.jobs = [];
    reapState.done = [];
  });

  it('kills the process group of a hung test job and marks it done with the timeout code', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    spawned.push(child);
    const job = mkJob({ id: 'hung', kind: 'test', pid: child.pid!, startedAt: OVER, finishedAt: null });
    reapState.jobs = [job];

    const reaped = await reapTimedOutTestJobs(NOW_MS);

    expect(reaped.map((j) => j.id)).toEqual(['hung']);
    expect(reapState.done).toEqual([{ id: 'hung', code: TEST_TIMEOUT_EXIT_CODE }]);

    const deadline = Date.now() + 3000;
    let dead = false;
    while (Date.now() < deadline) {
      try { process.kill(child.pid!, 0); } catch { dead = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(dead).toBe(true);
  });
});
