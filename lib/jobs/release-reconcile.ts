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
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
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

// Re-arm the burst budget after this cooldown. The 12-attempt burst rides out
// a short disruption, but a LONG one (e.g. a dev-server rebuild storm that
// keeps making the orchestrator's dynamic import fail, or the workflow runtime
// flapping for >6 min) can burn the entire burst while the release is actually
// recoverable — leaving it stranded in `running` until the 60-min wall-clock
// reaper. Once the last re-dispatch is this old, the next sweep resets the
// counter and tries again. This bounds pressure on a permanently-broken
// release to one burst per cooldown window while letting a transiently-stuck
// release self-heal after the storm passes.
export const RECONCILE_REARM_COOLDOWN_MS = 5 * 60 * 1000;

interface ReconcileAttemptState {
  count: number;
  lastAttemptAt: number;
}
const reconcileAttempts = new Map<string, ReconcileAttemptState>();

export interface StalledRelease {
  release: JobData;
  latestTerminalChild: JobData;
  idleMs: number;
}

/** Snapshot of releases that look stalled. Used by the probe sweep and
 *  exposed for unit tests + diagnostics. */
export function findStalledReleases(now: number = Date.now()): StalledRelease[] {
  const jobs = listJobs();
  // Single-pass index: collect in-flight releases and bucket pipeline-step
  // children by releaseId. One pass yields O(N), then each release just
  // reads its bucket instead of scanning all jobs per release.
  const releases: JobData[] = [];
  const childrenByRelease = new Map<string, JobData[]>();
  for (const j of jobs) {
    if (j.kind === 'release' && j.finishedAt === null) {
      releases.push(j);
      continue;
    }
    if (j.releaseId && PIPELINE_STEP_KINDS.has(j.kind)) {
      const arr = childrenByRelease.get(j.releaseId);
      if (arr) arr.push(j);
      else childrenByRelease.set(j.releaseId, [j]);
    }
  }
  const stalled: StalledRelease[] = [];
  for (const release of releases) {
    const children = childrenByRelease.get(release.id);
    if (!children || children.length === 0) continue;
    // Linear scan for liveChild + latest terminal child, instead of two
    // .filter() + .sort() passes.
    let hasLive = false;
    let latest: JobData | null = null;
    for (const c of children) {
      if (c.finishedAt === null) { hasLive = true; break; }
      if (typeof c.finishedAt === 'number' && c.finishedAt > 0) {
        if (!latest || c.finishedAt > (latest.finishedAt ?? 0)) latest = c;
      }
    }
    if (hasLive) continue;
    if (!latest || typeof latest.finishedAt !== 'number') continue;
    const idleMs = now - latest.finishedAt * 1000;
    if (idleMs < RECONCILE_QUIET_PERIOD_MS) continue;
    stalled.push({ release, latestTerminalChild: latest, idleMs });
  }
  return stalled;
}

// A release that acquired the pipeline lock but never started a single phase.
// This happens when the first phase's start helper refuses synchronously and
// `start-release` misclassifies the refusal as a transient "another driver
// already started this phase" 409, bowing out without finalizing — e.g. the
// PR-branch-execution gate refuses `test`/`review` on a non-default branch
// with an unverifiable dirty tree (the issue-cruncher's normal output). The
// release row then sits `running`, holds the lock, and blocks every cron until
// the 60-minute wall-clock reaper. `selfHealStaleLock` can't help: the holder
// is alive and unfinished. We detect the zombie by the total absence of any
// pipeline-step child after a quiet period measured from the release's own
// start, then finalize it (which releases the lock via `finalizeReleaseJob`).
//
// Quiet period is generous: the first phase is dispatched synchronously inside
// `startRelease` (a child row appears within milliseconds of the release row),
// so a healthy release is never childless this long. Queued releases never
// create a row and blocked releases are finalized on creation, so neither can
// be mistaken for a zombie here.
export const CHILDLESS_RELEASE_QUIET_MS = 120 * 1000;

export interface ChildlessStalledRelease {
  release: JobData;
  idleMs: number;
}

/** Snapshot of `running` releases that hold the pipeline lock but never
 *  started any phase. Used by the reconcile sweep and exposed for unit tests. */
export function findChildlessStalledReleases(now: number = Date.now()): ChildlessStalledRelease[] {
  const jobs = listJobs();
  const releases: JobData[] = [];
  const releaseHasChild = new Set<string>();
  for (const j of jobs) {
    if (j.kind === 'release' && j.finishedAt === null) {
      releases.push(j);
      continue;
    }
    if (j.releaseId && PIPELINE_STEP_KINDS.has(j.kind)) releaseHasChild.add(j.releaseId);
  }
  const out: ChildlessStalledRelease[] = [];
  for (const release of releases) {
    if (releaseHasChild.has(release.id)) continue;
    const idleMs = now - release.startedAt * 1000;
    if (idleMs < CHILDLESS_RELEASE_QUIET_MS) continue;
    out.push({ release, idleMs });
  }
  return out;
}

export interface ChildlessReapOutcome {
  releaseId: string;
  status: 'finalized' | 'finalize_failed';
  idleMs: number;
  error?: string;
}

/** Finalize a childless zombie release: records why on the row, marks it done
 *  (exit 1), and releases the pipeline lock. Idempotent — `finalizeReleaseJob`
 *  no-ops once `finishedAt` is set. */
export async function reapChildlessStalledRelease(
  stalled: ChildlessStalledRelease,
): Promise<ChildlessReapOutcome> {
  const { release, idleMs } = stalled;
  const reason = `release stalled: no pipeline phase started within ${Math.round(idleMs / 1000)}s — finalizing and releasing the lock`;
  try {
    try {
      const meta = release.contextMeta ? JSON.parse(release.contextMeta) : {};
      const merged = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : {};
      merged.releaseStopReason = reason;
      release.contextMeta = JSON.stringify(merged);
    } catch { /* best-effort — finalize regardless */ }
    if (release.logPath) {
      try { appendRedactedFileSync(release.logPath, `\n# ${reason}\n`); } catch {}
    }
    const { finalizeReleaseJob } = await import('@/lib/jobs/lifecycle');
    await finalizeReleaseJob(release, 1);
    console.log(
      `[release-reconcile] finalized childless stalled release ${release.id} (idle ${Math.round(idleMs / 1000)}s) — lock released`,
    );
    return { releaseId: release.id, status: 'finalized', idleMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[release-reconcile] finalize failed for childless release ${release.id}:`, error);
    return { releaseId: release.id, status: 'finalize_failed', idleMs, error };
  }
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
  now: number = Date.now(),
): Promise<ReconcileOutcome> {
  const { release, latestTerminalChild: child } = stalled;
  const prev = reconcileAttempts.get(release.id);
  // Re-arm the burst budget once the last re-dispatch is older than the
  // cooldown — a long storm can exhaust the burst on a release that is still
  // recoverable (see RECONCILE_REARM_COOLDOWN_MS).
  const reArmed = !!prev && (now - prev.lastAttemptAt) >= RECONCILE_REARM_COOLDOWN_MS;
  const priorCount = prev && !reArmed ? prev.count : 0;
  const attempt = priorCount + 1;
  if (attempt > MAX_RECONCILE_ATTEMPTS) {
    // Capped: leave the map untouched so the cooldown is measured from the
    // last real dispatch — otherwise every capped sweep would push the
    // re-arm deadline forward and the release could never recover.
    return { releaseId: release.id, childId: child.id, status: 'attempt_cap', attempt };
  }
  reconcileAttempts.set(release.id, { count: attempt, lastAttemptAt: now });
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
  // Reap childless zombie releases FIRST and unconditionally — finalizing one
  // releases the lock without starting any work, so it is safe under a global
  // pause and actively unblocks the rebuild drain (which waits for in-flight
  // pipeline jobs and would otherwise hang on the stuck `running` release).
  for (const childless of findChildlessStalledReleases(now)) {
    await reapChildlessStalledRelease(childless);
  }
  try {
    const { isJobsPaused } = await import('@/lib/shared/job-control');
    if (isJobsPaused()) return [];
  } catch {
    /* job-control unavailable — proceed with reconcile */
  }
  const stalled = findStalledReleases(now);
  const outcomes: ReconcileOutcome[] = [];
  for (const s of stalled) {
    outcomes.push(await reconcileStalledRelease(s, now));
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
  return reconcileAttempts.get(releaseId)?.count ?? 0;
}
