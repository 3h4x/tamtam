// Consumer of `job_completion_events`. Runs from the probe sweep (or any
// future graphile-worker tick); reads unconsumed rows oldest-first and
// dispatches the matching trigger. Marks `consumed_by` so a restart doesn't
// re-fire. Idempotency is also enforced by the unique index on jobId — a
// row is only inserted once per job in markDone.
//
// The hook chain in lib/jobs/lifecycle.ts still fires immediately on
// completion, so this consumer is the safety-net path for the failure
// case: server died between markDone's event insert and the hook return.
// The kill switch `legacy_completion_hook_release_after_run_enabled`
// stays on until this path is proven; once flipped off, this consumer
// is the only release-after-run trigger.

import { eq, isNull, asc } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

const CONSUMER_TAG = 'job-completion-router';

interface CompletionEventRow {
  id: number;
  jobId: string;
  kind: string;
  exitCode: number | null;
  project: string;
  releaseId: string | null;
  ghIssueNumber: number | null;
  emittedAt: number;
  consumedBy: string | null;
}

/** One sweep tick: process all unconsumed events oldest-first. Caller is
 *  responsible for scheduling (probe sweep, graphile-worker, …). Returns
 *  counts for observability. */
export async function consumeJobCompletionEvents(opts: { limit?: number } = {}): Promise<{ processed: number; routed: number; skipped: number }> {
  const limit = opts.limit ?? 50;
  let processed = 0;
  let routed = 0;
  let skipped = 0;

  const rows = await db.select()
    .from(schema.jobCompletionEvents)
    .where(isNull(schema.jobCompletionEvents.consumedBy))
    .orderBy(asc(schema.jobCompletionEvents.emittedAt))
    .limit(limit);

  for (const row of rows as CompletionEventRow[]) {
    processed += 1;
    try {
      const did = await routeEvent(row);
      if (did) routed += 1; else skipped += 1;
    } catch (err) {
      console.error(`[${CONSUMER_TAG}] route failed for job ${row.jobId}:`, err);
      skipped += 1;
    }
    try {
      await db.update(schema.jobCompletionEvents)
        .set({ consumedBy: CONSUMER_TAG, consumedAt: Date.now() / 1000 })
        .where(eq(schema.jobCompletionEvents.id, row.id))
        .execute();
    } catch (err) {
      console.error(`[${CONSUMER_TAG}] failed to mark consumed for event ${row.id}:`, err);
    }
  }

  return { processed, routed, skipped };
}

async function routeEvent(row: CompletionEventRow): Promise<boolean> {
  // Decide which trigger to call based on kind. Today: release-after-run for
  // run/agent kinds. release-after-fix-ci and auto-resume migrate in
  // Phase 1 wave 3.
  const { isAgentJobKind, getJobKind } = await import('@/lib/jobs/kinds');
  const k = getJobKind(row.kind);
  if (k === 'run' || isAgentJobKind(row.kind)) {
    // Avoid double-dispatch while the legacy inline hook is still the
    // primary path. When the kill switch is flipped off, this consumer
    // owns the dispatch.
    const { getSettings } = await import('@/lib/shared/config');
    if (getSettings().legacy_completion_hook_release_after_run_enabled) return false;
    const { getJob } = await import('@/lib/jobs/job-storage');
    const job = getJob(row.jobId);
    if (!job) return false;
    const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
    const out = await dispatchReleaseAfterRun(job);
    return out.dispatched;
  }
  return false;
}
