// Reconciler for stalled workflow-driven releases.
//
// The release pipeline's chain progresses by each phase workflow scheduling
// the next `releaseOrchestratorWorkflow` tick. If any link breaks
// (`start(orchestrator)` throws inside a phase workflow, the workflow
// runtime drops a run, the host crashes between markDone and the tick
// dispatch), the release meta-job sits in `running` indefinitely with all
// children already terminal — the orchestrator never sees the last child's
// completion, so it never finalizes.
//
// The probe sweep already finalizes releases past their wall-clock deadline,
// but that is a 60-minute fallback. This reconciler closes the gap by
// detecting "no in-flight children, latest terminal child finished N seconds
// ago, no chain progression observed" and re-dispatching the orchestrator
// tick on that latest terminal child. The orchestrator tick is idempotent —
// `waitStep` short-circuits on an already-finished job and `decideStep` +
// guards run from job state, so re-running is safe.

import { listJobs, PIPELINE_STEP_KINDS } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/types';

// How long the latest terminal child must have been idle before we
// suspect the chain is broken. Generous enough that a healthy orchestrator
// tick (poll cadence 5s) has had multiple chances to land.
const RECONCILE_QUIET_PERIOD_MS = 90 * 1000;

// Cap how often we re-kick a given release so a genuinely broken chain
// doesn't get hammered every probe cycle. Re-kicks are tracked in-process;
// resets on server restart (intentional — boot recovery runs its own
// cross-restart sweep).
// Each attempt fires on a probe cycle (30s). 3 attempts = 90s, which is
// often not enough when the workflow runtime needs a few restarts to
// stabilize (sweep + concurrent releases stress the runtime). 12 attempts
// = ~6 min of retries before giving up — long enough to ride out a
// rebuild + reseat cycle, short enough that a genuinely broken release
// doesn't hammer the queue forever.
export const MAX_RECONCILE_ATTEMPTS = 12;
const reconcileAttempts = new Map<string, number>();

export interface StalledRelease {
  release: JobData;
  latestTerminalChild: JobData;
  idleMs: number;
}

/** Snapshot of releases that look stalled. Used by the probe sweep and
 *  exposed for unit tests + diagnostics. */
export function findStalledReleases(now: number = Date.now()): StalledRelease[] {
  const jobs = listJobs();
  const releases = jobs.filter(
    (j) => j.kind === 'release' && j.finishedAt === null,
  );
  const stalled: StalledRelease[] = [];
  for (const release of releases) {
    const children = jobs.filter(
      (j) => j.releaseId === release.id && PIPELINE_STEP_KINDS.has(j.kind),
    );
    if (children.length === 0) continue;
    const liveChild = children.find((c) => c.finishedAt === null);
    if (liveChild) continue;
    const latest = children
      .filter((c) => typeof c.finishedAt === 'number' && c.finishedAt! > 0)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    if (!latest || typeof latest.finishedAt !== 'number') continue;
    const idleMs = now - latest.finishedAt * 1000;
    if (idleMs < RECONCILE_QUIET_PERIOD_MS) continue;
    stalled.push({ release, latestTerminalChild: latest, idleMs });
  }
  return stalled;
}

export interface ReconcileOutcome {
  releaseId: string;
  childId: string;
  status: 'redispatched' | 'attempt_cap' | 'dispatch_failed';
  attempt: number;
  error?: string;
}

/** Re-dispatch the orchestrator tick for the most recent terminal child of a
 *  stalled release. Idempotent on the workflow side; bounded on this side by
 *  `MAX_RECONCILE_ATTEMPTS`. */
export async function reconcileStalledRelease(
  stalled: StalledRelease,
): Promise<ReconcileOutcome> {
  const { release, latestTerminalChild: child } = stalled;
  const attempt = (reconcileAttempts.get(release.id) ?? 0) + 1;
  if (attempt > MAX_RECONCILE_ATTEMPTS) {
    return { releaseId: release.id, childId: child.id, status: 'attempt_cap', attempt };
  }
  reconcileAttempts.set(release.id, attempt);
  try {
    const { start } = await import('workflow/api');
    const { releaseOrchestratorWorkflow } = await import('@/lib/workflows/release-orchestrator');
    await start(releaseOrchestratorWorkflow, [
      child.id,
      { projectName: release.project, parentJobId: release.id },
    ]);
    console.log(
      `[release-reconcile] re-dispatched orchestrator for ${release.id} via ${child.id} (${child.kind}, attempt ${attempt}/${MAX_RECONCILE_ATTEMPTS})`,
    );
    return { releaseId: release.id, childId: child.id, status: 'redispatched', attempt };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[release-reconcile] dispatch failed for ${release.id}:`, error);
    return { releaseId: release.id, childId: child.id, status: 'dispatch_failed', attempt, error };
  }
}

/** Sweep entry point — finds stalled releases and re-kicks each one.
 *
 * Skips when jobs are globally paused. Without this, every paused-state
 * sweep re-dispatches the orchestrator, the phase fails with
 * "Jobs are paused globally", the attempt counter ticks, and a 10-minute
 * pause exhausts MAX_RECONCILE_ATTEMPTS for every in-flight release —
 * abandoning legitimate releases AND flooding the workflow_runs table
 * with dozens of identical 409 failures. */
export async function runReleaseReconcileSweep(
  now: number = Date.now(),
): Promise<ReconcileOutcome[]> {
  try {
    const { isJobsPaused } = await import('@/lib/shared/job-control');
    if (isJobsPaused()) return [];
  } catch {
    /* job-control unavailable — proceed with reconcile */
  }
  const stalled = findStalledReleases(now);
  const outcomes: ReconcileOutcome[] = [];
  for (const s of stalled) {
    outcomes.push(await reconcileStalledRelease(s));
  }
  return outcomes;
}

/** Internal-only — clears the attempt cap. Used by tests to keep cases
 *  isolated. Resetting in production would let a broken release thrash. */
export function _resetReconcileAttemptsForTest(): void {
  reconcileAttempts.clear();
}

/** Internal-only — used by tests to look up a release's current attempt count
 *  without exposing the map directly. */
export function _getReconcileAttemptForTest(releaseId: string): number {
  return reconcileAttempts.get(releaseId) ?? 0;
}
