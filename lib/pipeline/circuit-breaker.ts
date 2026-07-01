// Project circuit breaker — the macro complement to the per-run token/wall
// caps. When a project's runs keep failing (broken env, wedged dependency, a
// prerequisite that resets shared state), continuing to schedule agents just
// burns tokens on doomed work. After `project_failure_threshold` failed runs
// inside `project_failure_window_minutes`, pause the project's scheduling (same
// `projects.paused` flip an operator uses) and fire a `circuit_breaker_tripped`
// webhook. An operator resumes from Settings once the underlying issue is fixed.
import type { JobData } from '@/lib/jobs/types';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes';

/**
 * Top-level run kinds the breaker counts. Pipeline sub-steps (review/fix/commit
 * /push) are excluded — a single release can fail several sub-steps, which
 * would trip the breaker on one bad release rather than a sustained pattern.
 */
export function isBreakerCountableKind(kind: string): boolean {
  return kind === 'run' || kind === 'release' || isAgentJobKind(kind);
}

/** A finished job that genuinely failed (not clean, not user-cancelled). */
export function isCountableFailure(job: Pick<JobData, 'kind' | 'exitCode' | 'finishedAt'>): boolean {
  if (job.finishedAt === null) return false;
  if (!isBreakerCountableKind(job.kind)) return false;
  const code = job.exitCode;
  return code !== null && code !== 0 && !isCancelledExitCode(code);
}

/**
 * Pure count of countable failures for a project that finished within the
 * trailing window. `nowSec` and job `finishedAt` are in SECONDS.
 */
export function countRecentProjectFailures(
  jobs: JobData[],
  project: string,
  nowSec: number,
  windowSec: number,
): number {
  const cutoff = nowSec - windowSec;
  return jobs.filter(
    (j) => j.project === project && isCountableFailure(j) && (j.finishedAt ?? 0) >= cutoff,
  ).length;
}

/**
 * Evaluate + act after a job completes. No-op unless the just-finished job is
 * itself a countable failure and the threshold is armed. Trips at-most-once per
 * pause window: if the project is already paused, it skips (so every subsequent
 * failed completion doesn't re-notify). Best-effort; never throws.
 */
export async function maybeTripCircuitBreaker(job: JobData): Promise<boolean> {
  try {
    if (!isCountableFailure(job)) return false;
    const { getSettings } = await import('@/lib/shared/config');
    const settings = getSettings();
    const threshold = settings.project_failure_threshold;
    if (threshold <= 0) return false;

    const { isProjectPaused } = await import('@/lib/shared/enabled-projects');
    if (isProjectPaused(job.project)) return false;

    const { listJobs } = await import('@/lib/jobs/job-storage');
    const windowSec = settings.project_failure_window_minutes * 60;
    const nowSec = Date.now() / 1000;
    const failures = countRecentProjectFailures(listJobs(), job.project, nowSec, windowSec);
    if (failures < threshold) return false;

    const { pauseProject } = await import('@/lib/pipeline/pause-project');
    const paused = await pauseProject(job.project);
    if (!paused) return false;
    console.log(
      `[circuit-breaker] ${job.project} paused — ${failures} failed runs in ${settings.project_failure_window_minutes}min (threshold ${threshold})`,
    );

    try {
      const { notify } = await import('@/lib/shared/notifications');
      const logUrl = `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(job.project)}/history`;
      await notify({
        event: 'circuit_breaker_tripped',
        project: job.project,
        job_id: job.id,
        status: 'failed',
        reason: `${failures} failed runs in ${settings.project_failure_window_minutes}min`,
        message: `Circuit breaker tripped: ${failures} failed runs in ${settings.project_failure_window_minutes}min (threshold ${threshold}). Scheduling paused — resume from Settings once fixed.`,
        log_url: logUrl,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('[circuit-breaker] notify failed:', e);
    }
    return true;
  } catch (e) {
    console.error(`[circuit-breaker] evaluation failed for ${job.project}:`, e);
    return false;
  }
}
