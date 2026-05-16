// Boot helper: enqueue the `project-sweep` graphile-worker job. Mirrors
// `seedSystemCron` — re-seeds are jobKey-collision safe so subsequent
// reboots don't double-fire or reset the schedule.

import { quickAddJob } from 'graphile-worker';
import { PROJECT_SWEEP_JOB_KEY, PROJECT_SWEEP_INTERVAL_MS } from '@/lib/workflows/cron/project-sweep-task';

export interface SeedProjectSweepDeps {
  connectionString?: string;
  now?: () => number;
  /** First-fire delay after boot. Default: 60s — enough time for the
   *  workflow runtime to start, project cache to warm, and any boot-
   *  recovery jobs to settle before the first sweep dispatches work. */
  initialDelayMs?: number;
}

export interface SeedProjectSweepResult {
  enqueued: boolean;
  reason?: string;
  runAt?: Date;
}

export async function seedProjectSweep(
  deps: SeedProjectSweepDeps = {},
): Promise<SeedProjectSweepResult> {
  const connectionString = deps.connectionString
    ?? process.env.WORKFLOW_POSTGRES_URL
    ?? process.env.DATABASE_URL;
  if (!connectionString) return { enqueued: false, reason: 'no postgres URL' };

  const now = deps.now ?? Date.now;
  const initialDelayMs = deps.initialDelayMs ?? Math.min(60_000, PROJECT_SWEEP_INTERVAL_MS);
  const runAt = new Date(now() + initialDelayMs);
  try {
    await quickAddJob(
      { connectionString },
      'project-sweep',
      {},
      {
        jobKey: PROJECT_SWEEP_JOB_KEY,
        jobKeyMode: 'preserve_run_at',
        runAt,
        maxAttempts: 5,
      },
    );
    return { enqueued: true, runAt };
  } catch (err) {
    return {
      enqueued: false,
      reason: `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
