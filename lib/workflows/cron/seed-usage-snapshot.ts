// Boot helper: enqueue the singleton `usage-snapshot` graphile job.
// Mirrors `seedOrchestratorTick` — re-seeds are jobKey-collision safe so
// reboots don't double-fire or reset the cadence.

import { quickAddJob } from 'graphile-worker';
import {
  USAGE_SNAPSHOT_INTERVAL_MS,
  USAGE_SNAPSHOT_JOB_KEY,
} from '@/lib/workflows/cron/usage-snapshot-task';

export interface SeedUsageSnapshotDeps {
  connectionString?: string;
  now?: () => number;
  initialDelayMs?: number;
}

export interface SeedUsageSnapshotResult {
  enqueued: boolean;
  reason?: string;
  runAt?: Date;
}

export async function seedUsageSnapshot(
  deps: SeedUsageSnapshotDeps = {},
): Promise<SeedUsageSnapshotResult> {
  const connectionString = deps.connectionString
    ?? process.env.WORKFLOW_POSTGRES_URL
    ?? process.env.DATABASE_URL;
  if (!connectionString) return { enqueued: false, reason: 'no postgres URL' };

  const now = deps.now ?? Date.now;
  const initialDelayMs = deps.initialDelayMs ?? Math.min(60_000, USAGE_SNAPSHOT_INTERVAL_MS);
  const runAt = new Date(now() + initialDelayMs);
  try {
    await quickAddJob(
      { connectionString },
      'usage-snapshot',
      {},
      {
        jobKey: USAGE_SNAPSHOT_JOB_KEY,
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
