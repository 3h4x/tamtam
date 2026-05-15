// graphile-worker task handler for periodic system maintenance.
//
// Replaces the bare `setInterval(runCleanup, 24h)` in instrumentation-node.ts
// (and is the future home for budget-recovery wakeups + retention prune).
// Self-recursing on the same `system-cron` task — stays on graphile-worker's
// runAt scheduling so the cron survives Next.js restarts (a setInterval did
// not).
//
// Runs once a day; the boot helper (`seed-system-cron`) seeds the first
// enqueue if no `system-cron` job exists. After each fire, this handler
// re-enqueues itself for the next day.

import type { JobHelpers, Task } from 'graphile-worker';

export const SYSTEM_CRON_DAY_MS = 24 * 60 * 60 * 1000;
export const SYSTEM_CRON_JOB_KEY = 'system-cron';

export interface SystemCronDeps {
  /** Equivalent to the legacy `runNightlyCleanup` from `lib/jobs/retention.ts`.
   *  Run synchronously inside the task; the handler awaits before
   *  re-enqueuing so a slow cleanup doesn't double-fire. */
  runRetentionCleanup: () => Promise<void> | void;
  /** Re-enqueue the same `system-cron` task at `runAt`. Idempotent via
   *  `jobKey: SYSTEM_CRON_JOB_KEY` + replace mode. */
  enqueueNextFire: (runAt: Date) => Promise<void>;
  now?: () => number;
}

export interface SystemCronResult {
  cleanupOk: boolean;
  cleanupError?: string;
  nextFireAt: Date;
}

/** Pure handler — no graphile-worker / db imports. */
export async function handleSystemCron(deps: SystemCronDeps): Promise<SystemCronResult> {
  const now = deps.now ?? Date.now;
  let cleanupOk = true;
  let cleanupError: string | undefined;
  try {
    await deps.runRetentionCleanup();
  } catch (err) {
    cleanupOk = false;
    cleanupError = err instanceof Error ? err.message : String(err);
  }
  // Always re-enqueue — a transient cleanup failure shouldn't kill the
  // cron chain. graphile-worker's own retry policy handles task-level
  // crashes; we handle in-task errors ourselves so the next day's cleanup
  // still runs.
  const nextFireAt = new Date(now() + SYSTEM_CRON_DAY_MS);
  await deps.enqueueNextFire(nextFireAt);
  return { cleanupOk, cleanupError, nextFireAt };
}

export function createSystemCronTask(deps: SystemCronDeps): Task {
  return async (_payload, helpers: JobHelpers) => {
    const r = await handleSystemCron(deps);
    if (r.cleanupOk) {
      helpers.logger.info(`system-cron: cleanup ok, next fire ${r.nextFireAt.toISOString()}`);
    } else {
      helpers.logger.error(`system-cron: cleanup failed (${r.cleanupError}); re-enqueued at ${r.nextFireAt.toISOString()}`);
    }
  };
}
