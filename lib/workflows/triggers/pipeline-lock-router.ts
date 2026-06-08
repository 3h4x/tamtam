// Consumer of `pipeline_lock_events`. Reads unconsumed rows oldest-first
// and runs the project recovery drain (pending releases + queued agents)
// for each event's project. Marks `consumed_by` to make consumption
// idempotent across restarts.
//
// The inline `void drainPendingReleaseAsync(...)` in pipeline-lock.ts
// still fires immediately on release/heal — this consumer is the
// durable safety net for a crash mid-drain. Gated on a kill switch so
// the inline path stays primary until proven.

import { eq, isNull, asc } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

const CONSUMER_TAG = 'pipeline-lock-router';

interface LockEventRow {
  id: number;
  project: string;
  releasedByJobId: string | null;
  reason: string;
  emittedAt: number;
  consumedBy: string | null;
}

export async function consumePipelineLockEvents(opts: { limit?: number } = {}): Promise<{ processed: number; drained: number; skipped: number }> {
  const limit = opts.limit ?? 50;
  let processed = 0;
  let drained = 0;
  let skipped = 0;

  const rows = await db.select()
    .from(schema.pipelineLockEvents)
    .where(isNull(schema.pipelineLockEvents.consumedBy))
    .orderBy(asc(schema.pipelineLockEvents.emittedAt))
    .limit(limit);

  // Collapse multiple rows for the same project into one drain — repeated
  // events on the same project produce no additional work, just confirm
  // the drain happened.
  const drainedProjects = new Set<string>();

  for (const row of rows as LockEventRow[]) {
    processed += 1;
    try {
      const shouldDrain = await shouldDrainForEvent(row.project);
      if (shouldDrain && !drainedProjects.has(row.project)) {
        await drainForProject(row.project);
        drainedProjects.add(row.project);
        drained += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      console.error(`[${CONSUMER_TAG}] drain failed for project ${row.project}:`, err);
      skipped += 1;
    }
    try {
      await db.update(schema.pipelineLockEvents)
        .set({ consumedBy: CONSUMER_TAG, consumedAt: Date.now() / 1000 })
        .where(eq(schema.pipelineLockEvents.id, row.id))
        .execute();
    } catch (err) {
      console.error(`[${CONSUMER_TAG}] failed to mark consumed for event ${row.id}:`, err);
    }
  }

  return { processed, drained, skipped };
}

async function shouldDrainForEvent(_project: string): Promise<boolean> {
  // Gated on a kill switch so the inline `drainPendingReleaseAsync` in
  // pipeline-lock.ts remains the primary path until the operator flips
  // the inline drain off. Once flipped, this consumer is the durable backup.
  const { getSettings } = await import('@/lib/shared/config');
  return !getSettings().legacy_pipeline_lock_inline_drain_enabled;
}

async function drainForProject(projectName: string): Promise<void> {
  try {
    const { drainProjectRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    await drainProjectRecoveryWork(projectName, `[${CONSUMER_TAG}]`);
  } catch (e) {
    console.error(`[${CONSUMER_TAG}] recovery drain failed for ${projectName}:`, e);
  }
  try {
    const { drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
    await drainNextAgentRun(projectName);
  } catch (e) {
    console.error(`[${CONSUMER_TAG}] agent drain failed for ${projectName}:`, e);
  }
}
