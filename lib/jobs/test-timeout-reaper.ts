// Wall-clock reaper for hung detached jobs — the single, restart-safe liveness
// guard for background jobs that spawn a process group and finalize via
// `proc.on('close')` / `child.on('exit')`.
//
// `start-test.ts` spawns the test pipeline (`pnpm lint && type-check && test`)
// as a detached process group. When a forked Vitest worker enters a libuv
// busy-loop (an unclosed IPC/stream fd spins `onread` forever), `pnpm test`
// never exits, `close` never fires, and — if the next-server restarts — the
// detached group is reparented to PID 1 and keeps burning a CPU core
// indefinitely. testTimeout/hookTimeout don't help: the spin is in the worker
// runtime, not an interruptible test body.
//
// The same shape applies to mark-dod's acceptance-criteria verification, which
// now runs as a detached `mark-dod-verify` job (`startJobInProcess`) instead of
// a bespoke inline `setTimeout(300s)` kill-switch. Rather than give each kind
// its own timer, this module is the ONE wall-clock mechanism: a per-kind cap
// map governs which running jobs get their process group killed and marked done
// with a timeout exit code. Because it reads job rows rather than an in-process
// timer, it survives a server restart — the exact case an inline `setTimeout`
// could not.
import type { JobData } from '@/lib/jobs/types';
import { getSettings } from '@/lib/shared/config';

/** Wall-clock cap for a single test run. A full `pnpm test` is seconds; this is
 *  a generous ceiling that still catches hangs long before they cost a core for
 *  hours. */
export const TEST_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** Conventional `timeout(1)` exit code for "killed after deadline". */
export const TEST_TIMEOUT_EXIT_CODE = 124;

/**
 * Per-kind wall-clock cap, in ms. Returns null for kinds this reaper does not
 * bound (their liveness is handled elsewhere, e.g. the probe sweep's Claude
 * result-line detection). `mark-dod-verify` reads its cap from settings so it
 * stays operator-tunable.
 */
function timeoutMsForKind(kind: string): number | null {
  if (kind === 'test') return TEST_JOB_TIMEOUT_MS;
  if (kind === 'mark-dod-verify') return getSettings().mark_dod_verify_timeout_ms;
  return null;
}

/**
 * Pure decision: which running jobs have blown past their kind's wall-clock cap.
 *
 * `startedAt` is stored in SECONDS (see createJob in lib/jobs/storage.ts and the
 * age math in lib/jobs/probe.ts); `nowMs` is milliseconds.
 */
export function findTimedOutJobs(jobs: JobData[], nowMs: number = Date.now()): JobData[] {
  const nowSec = nowMs / 1000;
  return jobs.filter((j) => {
    if (j.finishedAt !== null || j.pid <= 0 || j.startedAt <= 0) return false;
    const capMs = timeoutMsForKind(j.kind);
    return capMs != null && nowSec - j.startedAt > capMs / 1000;
  });
}

/**
 * Back-compat: the test-only variant. Kept so existing callers/tests that name
 * `test` explicitly keep working; delegates to the kind-agnostic finder.
 */
export function findTimedOutTestJobs(
  jobs: JobData[],
  nowMs: number = Date.now(),
): JobData[] {
  return findTimedOutJobs(jobs, nowMs).filter((j) => j.kind === 'test');
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
 * Find timed-out jobs of any capped kind (test, mark-dod-verify, …), kill their
 * process groups, and mark them done with the timeout exit code. Returns the
 * jobs that were reaped. Safe to call every probe sweep and once at boot.
 */
export async function reapTimedOutClaudeJobs(nowMs: number = Date.now()): Promise<JobData[]> {
  const { listJobs, markDone } = await import('@/lib/jobs/job-storage');
  const timedOut = findTimedOutJobs(listJobs(), nowMs);
  for (const job of timedOut) {
    const ageMin = Math.round((nowMs / 1000 - job.startedAt) / 60);
    const capMin = Math.round((timeoutMsForKind(job.kind) ?? 0) / 60000);
    console.log(
      `[job-timeout-reaper] ${job.kind} job ${job.id} ran ${ageMin}min (cap ${capMin}min); killing group pid=${job.pid}`,
    );
    killJobProcessGroup(job.pid);
    try {
      await markDone(job, TEST_TIMEOUT_EXIT_CODE);
    } catch (e) {
      console.error(`[job-timeout-reaper] markDone failed for ${job.id}:`, e);
    }
  }
  return timedOut;
}

/**
 * Back-compat alias for callers that predate the kind-agnostic reaper. Now
 * covers every capped kind, not just `test`.
 */
export async function reapTimedOutTestJobs(nowMs: number = Date.now()): Promise<JobData[]> {
  return reapTimedOutClaudeJobs(nowMs);
}
