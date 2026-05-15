// Retention sweep for the `workflow.workflow_*` tables that the Vercel
// Workflow runtime owns. Runs from the daily `system-cron` graphile-worker
// task — see `lib/workflows/cron/system-cron-task.ts`.
//
// Without this, `workflow_runs` and `workflow_events` grow unbounded — the
// migration plan flagged that as a risk (`workflow_*` table growth). The
// runtime never deletes its own rows so we own the trim.
//
// Strategy: pick terminal-state runs (`completed | failed | cancelled`)
// older than the cutoff, then delete the dependent rows from each child
// table in one transaction. There are no foreign keys in the workflow
// schema as of this writing, so the order doesn't matter for integrity,
// but we delete children first so a partial failure can't strand orphans.
//
// Connection: uses `WORKFLOW_POSTGRES_URL` if set (the dedicated workflow
// DB), falling back to `DATABASE_URL`. Opens a fresh `pg.Pool` because the
// rest of the app uses Drizzle against application tables.

import { Pool } from 'pg';

export interface WorkflowRetentionSummary {
  status: 'completed' | 'disabled' | 'failed';
  retentionDays: number;
  cutoffIso: string;
  runsDeleted: number;
  eventsDeleted: number;
  stepsDeleted: number;
  waitsDeleted: number;
  hooksDeleted: number;
  streamChunksDeleted: number;
  errorCount: number;
  lastError: string | null;
  durationMs: number;
}

export interface PruneOptions {
  retentionDays: number;
  /** Override the DB URL — useful in tests. */
  connectionString?: string;
}

export async function pruneOldWorkflowRuns(opts: PruneOptions): Promise<WorkflowRetentionSummary> {
  const startedAt = Date.now();
  const summary: WorkflowRetentionSummary = {
    status: 'completed',
    retentionDays: opts.retentionDays,
    cutoffIso: '',
    runsDeleted: 0,
    eventsDeleted: 0,
    stepsDeleted: 0,
    waitsDeleted: 0,
    hooksDeleted: 0,
    streamChunksDeleted: 0,
    errorCount: 0,
    lastError: null,
    durationMs: 0,
  };

  if (opts.retentionDays <= 0) {
    summary.status = 'disabled';
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const url = opts.connectionString ?? process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    summary.status = 'disabled';
    summary.lastError = 'no postgres URL configured';
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const cutoffMs = Date.now() - opts.retentionDays * 86400_000;
  summary.cutoffIso = new Date(cutoffMs).toISOString();

  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Pick terminal runs older than cutoff. We exclude `running` and
      // `pending` so an in-progress release isn't truncated.
      const { rows: oldRuns } = await client.query<{ id: string }>(
        `SELECT id FROM workflow.workflow_runs
         WHERE status IN ('completed','failed','cancelled')
           AND completed_at IS NOT NULL
           AND completed_at < $1`,
        [summary.cutoffIso],
      );

      if (oldRuns.length === 0) {
        await client.query('COMMIT');
        summary.durationMs = Date.now() - startedAt;
        return summary;
      }

      const ids = oldRuns.map((r) => r.id);

      const ev = await client.query('DELETE FROM workflow.workflow_events WHERE run_id = ANY($1::text[])', [ids]);
      summary.eventsDeleted = ev.rowCount ?? 0;
      const st = await client.query('DELETE FROM workflow.workflow_steps WHERE run_id = ANY($1::text[])', [ids]);
      summary.stepsDeleted = st.rowCount ?? 0;
      const wa = await client.query('DELETE FROM workflow.workflow_waits WHERE run_id = ANY($1::text[])', [ids]);
      summary.waitsDeleted = wa.rowCount ?? 0;
      const ho = await client.query('DELETE FROM workflow.workflow_hooks WHERE run_id = ANY($1::text[])', [ids]);
      summary.hooksDeleted = ho.rowCount ?? 0;
      const sc = await client.query('DELETE FROM workflow.workflow_stream_chunks WHERE run_id = ANY($1::text[])', [ids]);
      summary.streamChunksDeleted = sc.rowCount ?? 0;
      const runsRes = await client.query(
        'DELETE FROM workflow.workflow_runs WHERE id = ANY($1::text[])',
        [ids],
      );
      summary.runsDeleted = runsRes.rowCount ?? 0;

      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      summary.status = 'failed';
      summary.errorCount += 1;
      summary.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      client.release();
    }
  } catch (e) {
    summary.status = 'failed';
    summary.errorCount += 1;
    summary.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    await pool.end().catch(() => { /* ignore */ });
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}
