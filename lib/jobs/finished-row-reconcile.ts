import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { listJobs } from '@/lib/jobs/storage';
import { releaseDurableAgentRunSlotForJob } from '@/lib/agents/durable-agent-run-slot';

// Self-heal for finalize writes that never reached Postgres.
//
// `saveToDb` is fire-and-forget (`void saveToDbAsync`) and swallows errors, so
// when a job finalizes (`markDone` updates the in-memory cache and calls
// saveToDb) while the DB is momentarily unreachable — a Postgres restart, the
// rebuild's stop/start window, a transient connection drop — the row's
// `finished_at` write is lost. The cache then reads `done` while the DB row
// stays `finished_at = NULL` forever (nothing re-syncs a live server's cache to
// the DB). That zombie row reads as "still running" to every DB-only consumer:
// most damagingly the durable agent-run slot (`activeJobExists`), which then
// 409-blocks every future run of that agent on the project indefinitely.
//
// The probe sweep can't catch it: it only re-probes jobs the cache still marks
// running (`finishedAt === null`), and the cache already considers this one
// done. So we reconcile the other direction here — cache→DB — re-persisting the
// cache's terminal state onto any open DB row the cache has already finalized,
// and freeing the durable slot that row was pinning.
//
// Idempotent: the `WHERE finished_at IS NULL` guard means a row that's already
// (or concurrently) finalized is left untouched.
export async function reconcileFinishedDbRows(): Promise<number> {
  let open: Array<{ id: string }>;
  try {
    open = await db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(isNull(schema.jobs.finishedAt));
  } catch (err) {
    console.error('[finished-row-reconcile] DB read failed:', err);
    return 0;
  }
  if (open.length === 0) return 0;

  const cacheById = new Map(listJobs().map((j) => [j.id, j]));
  let fixed = 0;
  for (const row of open) {
    const cached = cacheById.get(row.id);
    // Cache also shows it open (genuinely running, or the cache lost it too on a
    // restart) → not our case; the normal probe sweep finalizes those.
    if (!cached || cached.finishedAt == null) continue;
    try {
      const res = await db
        .update(schema.jobs)
        .set({
          finishedAt: cached.finishedAt,
          abortedAt: cached.abortedAt ?? null,
          exitCode: cached.exitCode ?? -1,
          durationMs: cached.durationMs ?? null,
        })
        .where(and(eq(schema.jobs.id, row.id), isNull(schema.jobs.finishedAt)))
        .execute();
      // pg returns rowCount; treat any non-error as healed (the guard makes it
      // a no-op if another writer won the race).
      if ((res as { rowCount?: number }).rowCount !== 0) {
        fixed += 1;
        console.warn(
          `[finished-row-reconcile] re-persisted lost finalize for ${row.id} ` +
            `(exit ${cached.exitCode ?? -1}) — its finalize DB write was dropped`,
        );
        // Free any durable agent-run slot this zombie was pinning so the next
        // run isn't 409-blocked while waiting for the slot's own staleness path.
        try {
          await releaseDurableAgentRunSlotForJob({ project: cached.project, id: row.id });
        } catch (err) {
          console.error(`[finished-row-reconcile] slot release failed for ${row.id}:`, err);
        }
      }
    } catch (err) {
      console.error(`[finished-row-reconcile] re-persist failed for ${row.id}:`, err);
    }
  }
  if (fixed > 0) {
    console.log(`[finished-row-reconcile] healed ${fixed} job row(s) whose finalize DB write was lost`);
  }
  return fixed;
}
