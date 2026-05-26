// Boot helper: enqueue the singleton `orchestrator-tick` graphile job.
// Mirrors `seedProjectSweep` — re-seeds are jobKey-collision safe so
// reboots don't double-fire or reset the cadence.

import { quickAddJob } from 'graphile-worker';
import {
  ORCHESTRATOR_TICK_INTERVAL_MS,
  ORCHESTRATOR_TICK_JOB_KEY,
} from '@/lib/workflows/cron/orchestrator-tick-task';

export interface SeedOrchestratorTickDeps {
  connectionString?: string;
  now?: () => number;
  /** First-fire delay after boot. Default 60s — enough time for the
   *  workflow runtime to start and the project/agent caches to warm
   *  before the first decision runs. */
  initialDelayMs?: number;
}

export interface SeedOrchestratorTickResult {
  enqueued: boolean;
  reason?: string;
  runAt?: Date;
}

export async function seedOrchestratorTick(
  deps: SeedOrchestratorTickDeps = {},
): Promise<SeedOrchestratorTickResult> {
  const connectionString = deps.connectionString
    ?? process.env.WORKFLOW_POSTGRES_URL
    ?? process.env.DATABASE_URL;
  if (!connectionString) return { enqueued: false, reason: 'no postgres URL' };

  const now = deps.now ?? Date.now;
  const initialDelayMs = deps.initialDelayMs ?? Math.min(60_000, ORCHESTRATOR_TICK_INTERVAL_MS);
  const runAt = new Date(now() + initialDelayMs);
  try {
    await quickAddJob(
      { connectionString },
      'orchestrator-tick',
      {},
      {
        jobKey: ORCHESTRATOR_TICK_JOB_KEY,
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
