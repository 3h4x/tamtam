// Wall-clock reaper for hung `test` jobs.
//
// `start-test.ts` spawns the test pipeline (`pnpm lint && type-check && test`)
// as a detached process group and only finalizes the job via `proc.on('close')`.
// When a forked Vitest worker enters a libuv busy-loop (an unclosed IPC/stream
// fd spins `onread` forever), `pnpm test` never exits, `close` never fires, and
// — if the next-server restarts — the detached group is reparented to PID 1 and
// keeps burning a CPU core indefinitely. testTimeout/hookTimeout don't help:
// the spin is in the worker runtime, not an interruptible test body.
//
// This module bounds that: any running `test` job older than the wall-clock cap
// gets its process group killed and is marked done with a timeout exit code.
// It mirrors the existing `release` timeout sweep in instrumentation-node/
// probe-sweep.ts (deadline filter → abort), and — because it reads job rows
// rather than relying on an in-process timer — it survives a server restart,
// which is the exact case that orphaned today's runs.
import type { JobData } from '@/lib/jobs/types';

/** Wall-clock cap for a single test run. A full `pnpm test` is seconds; this is
 *  a generous ceiling that still catches hangs long before they cost a core for
 *  hours. */
export const TEST_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** Conventional `timeout(1)` exit code for "killed after deadline". */
export const TEST_TIMEOUT_EXIT_CODE = 124;

/**
 * Pure decision: which running `test` jobs have blown past the wall-clock cap.
 *
 * `startedAt` is stored in SECONDS (see createJob in lib/jobs/storage.ts and the
 * age math in lib/jobs/probe.ts); `nowMs` is milliseconds.
 */
export function findTimedOutTestJobs(
  jobs: JobData[],
  nowMs: number = Date.now(),
  timeoutMs: number = TEST_JOB_TIMEOUT_MS,
): JobData[] {
  const nowSec = nowMs / 1000;
  const timeoutSec = timeoutMs / 1000;
  return jobs.filter(
    (j) =>
      j.kind === 'test' &&
      j.finishedAt === null &&
      j.pid > 0 &&
      j.startedAt > 0 &&
      nowSec - j.startedAt > timeoutSec,
  );
}

/**
 * SIGTERM the whole process group, then SIGKILL after a grace period for
 * anything that ignores the term. The negative pid targets the group — this
 * works because start-test spawns the runner `detached`, so `job.pid` is the
 * group leader.
 *
 * Hard safety guard: never signal pgid 0/1 or our own group. `process.kill(-0)`
 * / `process.kill(-process.pid)` would hit the caller's own process group and
 * take down the next-server itself (this is exactly how a manual broad group
 * kill knocked over tamtam during the incident this module fixes).
 */
export function killJobProcessGroup(pid: number, graceMs = 10_000): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* group already gone */
  }
  const t = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }, graceMs);
  // Don't keep the event loop (or a Vitest worker) alive waiting on the grace.
  t.unref?.();
}

/**
 * Find timed-out test jobs, kill their process groups, and mark them done with
 * the timeout exit code. Returns the jobs that were reaped. Safe to call every
 * probe sweep and once at boot.
 */
export async function reapTimedOutTestJobs(nowMs: number = Date.now()): Promise<JobData[]> {
  const { listJobs, markDone } = await import('@/lib/jobs/job-storage');
  const timedOut = findTimedOutTestJobs(listJobs(), nowMs);
  for (const job of timedOut) {
    const ageMin = Math.round((nowMs / 1000 - job.startedAt) / 60);
    console.log(
      `[test-timeout-reaper] test job ${job.id} ran ${ageMin}min (cap ${TEST_JOB_TIMEOUT_MS / 60000}min); killing group pid=${job.pid}`,
    );
    killJobProcessGroup(job.pid);
    try {
      await markDone(job, TEST_TIMEOUT_EXIT_CODE);
    } catch (e) {
      console.error(`[test-timeout-reaper] markDone failed for ${job.id}:`, e);
    }
  }
  return timedOut;
}
