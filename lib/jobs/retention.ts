import { unlinkSync, existsSync } from 'fs';
import { lt, and, isNotNull, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';

export interface RetentionConfig {
  log_retention_count: number;
  log_retention_days: number;
  job_row_retention_days: number;
}

/**
 * Prune old log files for a project after a run completes.
 * Keeps the last `log_retention_count` finished runs per project, and/or
 * runs newer than `log_retention_days`. Deletes on-disk log files and sets
 * `log_pruned=true` on the DB row; the row itself is preserved for history.
 */
export function pruneProjectLogs(project: string, cfg?: RetentionConfig): void {
  const settings = cfg ?? getSettings();
  const { log_retention_count, log_retention_days } = settings;

  // Treat 0 (or negative) as "disabled" for either dimension.
  const countEnabled = log_retention_count > 0;
  const ageEnabled = log_retention_days > 0;
  if (!countEnabled && !ageEnabled) return;

  const cutoffTs = ageEnabled ? Date.now() / 1000 - log_retention_days * 86400 : -Infinity;

  // Get all finished jobs for this project, newest first.
  const rows = db
    .select({ id: schema.jobs.id, logPath: schema.jobs.logPath, startedAt: schema.jobs.startedAt, logPruned: schema.jobs.logPruned })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.project, project), isNotNull(schema.jobs.finishedAt)))
    .all()
    .sort((a, b) => b.startedAt - a.startedAt);

  const toPrune: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.logPruned) continue;
    const overCount = countEnabled && i >= log_retention_count;
    const overAge = ageEnabled && row.startedAt < cutoffTs;
    if (overCount || overAge) toPrune.push(row.id);
  }

  for (const id of toPrune) {
    const row = rows.find(r => r.id === id);
    if (!row) continue;
    if (row.logPath && existsSync(row.logPath)) {
      try { unlinkSync(row.logPath); } catch {}
    }
    try {
      db.update(schema.jobs)
        .set({ logPruned: true })
        .where(eq(schema.jobs.id, id))
        .run();
    } catch {}
  }
}

/**
 * Nightly cleanup: delete `jobs` rows older than `job_row_retention_days`.
 * Only removes finished rows (finishedAt IS NOT NULL) to avoid touching
 * running jobs.
 */
export function runNightlyCleanup(cfg?: RetentionConfig): void {
  const settings = cfg ?? getSettings();
  const { job_row_retention_days } = settings;

  // 0 (or negative) disables row deletion entirely.
  if (job_row_retention_days <= 0) return;

  const cutoffTs = Date.now() / 1000 - job_row_retention_days * 86400;

  try {
    db.delete(schema.jobs)
      .where(and(isNotNull(schema.jobs.finishedAt), lt(schema.jobs.startedAt, cutoffTs)))
      .run();
  } catch (e) {
    console.error('[retention] nightly cleanup failed:', e);
  }
}
