// Boot helper: enqueue the single `system-cron` job (daily retention
// cleanup) via graphile-worker with `jobKey = system-cron` so re-boots
// don't duplicate. Symmetric to `seedAgentCrons` but for the singleton
// system-maintenance task.
//
// First boot ever: schedules cleanup for an hour from now (gives the
// process time to settle before doing DB-heavy work).
// Subsequent boots: jobKey collision means the existing pending job
// stays — we don't reset its scheduled runAt.

import { quickAddJob } from 'graphile-worker';
import { SYSTEM_CRON_JOB_KEY } from '@/lib/workflows/cron/system-cron-task';

export interface SeedSystemCronDeps {
  connectionString?: string;
  /** Override Date.now for testing. */
  now?: () => number;
  /** First-boot delay before initial cleanup. Defaults to 1 hour. */
  initialDelayMs?: number;
}

export interface SeedSystemCronResult {
  enqueued: boolean;
  reason?: string;
  runAt?: Date;
}

export async function seedSystemCron(
  deps: SeedSystemCronDeps = {},
): Promise<SeedSystemCronResult> {
  const connectionString = deps.connectionString
    ?? process.env.WORKFLOW_POSTGRES_URL
    ?? process.env.DATABASE_URL;
  if (!connectionString) {
    return { enqueued: false, reason: 'no postgres URL' };
  }
  const now = deps.now ?? Date.now;
  const initialDelayMs = deps.initialDelayMs ?? 60 * 60 * 1000;
  const runAt = new Date(now() + initialDelayMs);
  try {
    await quickAddJob(
      { connectionString },
      'system-cron',
      {},
      {
        jobKey: SYSTEM_CRON_JOB_KEY,
        // 'preserve_run_at' keeps a previously-scheduled runAt even if we
        // re-seed on boot. Without this every restart would reset the
        // cleanup schedule, potentially never letting it fire.
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
