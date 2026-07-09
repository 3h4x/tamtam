// Circuit-breaker auto-resume — the self-healing complement to
// `maybeTripCircuitBreaker`. A breaker pause exists to stop burning tokens on
// doomed work; its own contract (see circuit-breaker.ts) is "an operator resumes
// once the underlying issue is fixed." A *countable run that succeeds after the
// pause* is direct proof the issue is fixed — so keeping the project paused (and
// nagging the inbox with a stale `project_paused` HITL) is wrong. This reconciler
// resumes such projects so the pause self-clears instead of becoming "last
// year's snow." It re-trips on its own if failures resume, so it stays bounded.
//
// Scope: ONLY circuit-breaker pauses (reason carries CIRCUIT_BREAKER_REASON_PREFIX).
// Soak / push-hook pauses have different semantics and are never auto-resumed.
//
// A merely-hidden signal would leave the project paused-but-invisible — a silent
// pause, which the operator-facing invariant forbids. So the fix RESUMES (state
// stays consistent), never just suppresses the row.
import { isBreakerCountableKind, isCountableFailure, CIRCUIT_BREAKER_REASON_PREFIX } from '@/lib/pipeline/circuit-breaker';

/** Minimal job projection the pure decision works over — satisfied by both
 *  `JobData` (sweep) and `InboxJob` (inbox derivation). */
export interface ResumeJob {
  project: string;
  kind: string;
  exitCode: number | null;
  finishedAt: number | null;
}

/** True only for a pause raised by the circuit breaker (not soak / push-hook). */
export function isCircuitBreakerPause(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(CIRCUIT_BREAKER_REASON_PREFIX);
}

/**
 * Finish time (seconds) of the most recent COUNTABLE failure for a project — the
 * run that tripped the breaker. Used as the pause baseline when no explicit
 * `paused_at` was recorded (pauses that predate timestamp storage), and to date
 * the `project_paused` inbox signal. Null when the project has no countable
 * failure on record.
 */
export function latestCountableFailureFinishedAt(jobs: ResumeJob[], project: string): number | null {
  let best: number | null = null;
  for (const j of jobs) {
    if (j.project !== project) continue;
    if (!isCountableFailure(j)) continue;
    const fin = j.finishedAt as number; // isCountableFailure guarantees finishedAt != null
    if (best === null || fin > best) best = fin;
  }
  return best;
}

/**
 * True when a countable run (run / release / agent:*) COMPLETED SUCCESSFULLY
 * (exit 0) after `sinceSec` — proof the environment recovered. Symmetric with
 * what trips the breaker (countable failures), so a passing pipeline sub-step
 * (fix / review) alone does NOT count.
 */
export function hasCountableSuccessAfter(jobs: ResumeJob[], project: string, sinceSec: number): boolean {
  return jobs.some(
    (j) =>
      j.project === project &&
      isBreakerCountableKind(j.kind) &&
      j.finishedAt !== null &&
      j.finishedAt > sinceSec &&
      j.exitCode === 0,
  );
}

/**
 * Pure decision: should this circuit-breaker pause be auto-resumed now? True iff
 * it is a breaker pause AND a countable success landed after the pause moment
 * (the recorded `pausedAt`, else the tripping failure's finish time).
 */
export function shouldResumeCircuitBreakerPause(args: {
  project: string;
  reason: string | null | undefined;
  pausedAt: number | null | undefined;
  jobs: ResumeJob[];
  nowSec: number;
}): boolean {
  if (!isCircuitBreakerPause(args.reason)) return false;
  const since = args.pausedAt ?? latestCountableFailureFinishedAt(args.jobs, args.project);
  if (since == null) return false;
  return hasCountableSuccessAfter(args.jobs, args.project, since);
}

/**
 * Reconciler: resume every circuit-breaker-paused project whose failures a later
 * countable success proved resolved. Best-effort; never throws. Returns the
 * names of the projects it resumed. Wired into the 30 s probe sweep below the
 * DB-reachability gate.
 */
export async function runCircuitBreakerAutoResumeSweep(): Promise<string[]> {
  const resumed: string[] = [];
  try {
    const { listPauseReasons, listPausedAt, resumeProject } = await import('@/lib/pipeline/pause-project');
    const reasons = await listPauseReasons().catch(() => ({}) as Record<string, string>);
    const breakerPauses = Object.entries(reasons).filter(([, reason]) => isCircuitBreakerPause(reason));
    if (breakerPauses.length === 0) return resumed;

    const pausedAt = await listPausedAt().catch(() => ({}) as Record<string, number>);
    const { listJobs } = await import('@/lib/jobs/job-storage');
    const { isProjectPaused } = await import('@/lib/shared/enabled-projects');
    const jobs = listJobs() as ResumeJob[];
    const nowSec = Date.now() / 1000;

    for (const [project, reason] of breakerPauses) {
      // Re-check paused: a manual resume between the reason read and here would
      // have cleared the flag; don't fight the operator (or race another sweep).
      if (!isProjectPaused(project)) continue;
      if (!shouldResumeCircuitBreakerPause({ project, reason, pausedAt: pausedAt[project], jobs, nowSec })) continue;
      const ok = await resumeProject(project);
      if (ok) {
        resumed.push(project);
        console.log(
          `[circuit-breaker] ${project} auto-resumed — a countable run succeeded after the pause (breaker premise resolved)`,
        );
      }
    }
  } catch (err) {
    console.error('[circuit-breaker] auto-resume sweep failed:', err);
  }
  return resumed;
}
