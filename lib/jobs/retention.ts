import { unlinkSync, statSync } from 'fs';
import { lt, and, isNotNull, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { isUndefinedTableError } from '@/lib/db/errors';
import { getSettings } from '@/lib/shared/config';

export interface RetentionConfig {
  log_retention_count: number;
  log_retention_days: number;
  job_row_retention_days: number;
}

type CleanupStatus = 'completed' | 'disabled' | 'failed';

export interface ProjectLogRetentionSummary {
  type: 'project_logs';
  project: string;
  status: CleanupStatus;
  startedAt: number;
  finishedAt: number;
  rowsScanned: number;
  rowsEligible: number;
  rowsUpdated: number;
  logFilesDeleted: number;
  bytesReclaimed: number;
  skippedRunningRows: number;
  errorCount: number;
  lastError: string | null;
}

export interface NightlyRetentionSummary {
  type: 'nightly';
  status: CleanupStatus;
  startedAt: number;
  finishedAt: number;
  rowsScanned: number;
  rowsDeleted: number;
  skippedRunningRows: number;
  errorCount: number;
  lastError: string | null;
}

export type RetentionSummary = ProjectLogRetentionSummary | NightlyRetentionSummary;

const PROJECT_LOG_RETENTION_STATUS_KEY = 'retention:project-logs:last';
const NIGHTLY_RETENTION_STATUS_KEY = 'retention:nightly:last';

function nowSeconds(): number {
  return Date.now() / 1000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function getRetentionStatusKey(summary: RetentionSummary): string {
  return summary.type === 'project_logs'
    ? PROJECT_LOG_RETENTION_STATUS_KEY
    : NIGHTLY_RETENTION_STATUS_KEY;
}

function persistRetentionSummary(summary: RetentionSummary): void {
  const key = getRetentionStatusKey(summary);
  void db.insert(schema.maintenanceStatus)
    .values({
      key,
      value: JSON.stringify(summary),
      updatedAt: nowSeconds(),
    })
    .onConflictDoUpdate({
      target: schema.maintenanceStatus.key,
      set: {
        value: JSON.stringify(summary),
        updatedAt: nowSeconds(),
      },
    })
    .execute()
    .catch(e => {
      if (!isUndefinedTableError(e)) {
        console.error('[retention] failed to persist cleanup summary:', e);
      }
    });
}

async function readRetentionSummary<T extends RetentionSummary>(key: string): Promise<T | null> {
  try {
    const rows = await db.select({ value: schema.maintenanceStatus.value })
      .from(schema.maintenanceStatus)
      .where(eq(schema.maintenanceStatus.key, key))
      .limit(1);
    if (!rows[0]) return null;
    return JSON.parse(rows[0].value) as T;
  } catch (e) {
    if (isUndefinedTableError(e)) return null;
    console.error('[retention] failed to read cleanup summary:', e);
    return null;
  }
}

export async function getLatestProjectLogRetentionSummary(): Promise<ProjectLogRetentionSummary | null> {
  return readRetentionSummary<ProjectLogRetentionSummary>(PROJECT_LOG_RETENTION_STATUS_KEY);
}

export async function getLatestNightlyRetentionSummary(): Promise<NightlyRetentionSummary | null> {
  return readRetentionSummary<NightlyRetentionSummary>(NIGHTLY_RETENTION_STATUS_KEY);
}

/**
 * Prune old log files for a project after a run completes.
 */
export async function pruneProjectLogs(project: string, cfg?: RetentionConfig): Promise<ProjectLogRetentionSummary> {
  const startedAt = nowSeconds();
  const summary: ProjectLogRetentionSummary = {
    type: 'project_logs',
    project,
    status: 'completed',
    startedAt,
    finishedAt: startedAt,
    rowsScanned: 0,
    rowsEligible: 0,
    rowsUpdated: 0,
    logFilesDeleted: 0,
    bytesReclaimed: 0,
    skippedRunningRows: 0,
    errorCount: 0,
    lastError: null,
  };
  const settings = cfg ?? getSettings();
  const { log_retention_count, log_retention_days } = settings;

  const countEnabled = log_retention_count > 0;
  const ageEnabled = log_retention_days > 0;
  if (!countEnabled && !ageEnabled) {
    summary.status = 'disabled';
    summary.finishedAt = nowSeconds();
    persistRetentionSummary(summary);
    return summary;
  }

  const cutoffTs = ageEnabled ? nowSeconds() - log_retention_days * 86400 : -Infinity;

  const runningRows = await db.select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.project, project), isNull(schema.jobs.finishedAt)));
  summary.skippedRunningRows = runningRows.length;

  const rows = (await db
    .select({ id: schema.jobs.id, logPath: schema.jobs.logPath, startedAt: schema.jobs.startedAt, logPruned: schema.jobs.logPruned })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.project, project), isNotNull(schema.jobs.finishedAt))))
    .sort((a, b) => b.startedAt - a.startedAt);
  summary.rowsScanned = rows.length;

  // Collect eligible rows in one pass to avoid re-finding each row by ID.
  // The rows array is already sorted descending by startedAt so the
  // index-based count check still applies.
  type EligibleRow = { id: string; logPath: string | null };
  const toPrune: EligibleRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.logPruned) continue;
    const overCount = countEnabled && i >= log_retention_count;
    const overAge = ageEnabled && row.startedAt < cutoffTs;
    if (overCount || overAge) toPrune.push({ id: row.id, logPath: row.logPath });
  }
  summary.rowsEligible = toPrune.length;

  for (const row of toPrune) {
    if (row.logPath) {
      try {
        const size = statSync(/*turbopackIgnore: true*/ row.logPath).size;
        unlinkSync(/*turbopackIgnore: true*/ row.logPath);
        summary.logFilesDeleted += 1;
        summary.bytesReclaimed += size;
      } catch (e) {
        if (isMissingFileError(e)) {
          // Missing already equals pruned; keep the row update idempotent.
        } else {
          summary.errorCount += 1;
          summary.lastError = errorMessage(e);
        }
      }
    }
    try {
      await db.update(schema.jobs)
        .set({ logPruned: true })
        .where(eq(schema.jobs.id, row.id))
        .execute();
      summary.rowsUpdated += 1;
    } catch (e) {
      summary.errorCount += 1;
      summary.lastError = errorMessage(e);
    }
  }

  summary.status = summary.errorCount > 0 ? 'failed' : 'completed';
  summary.finishedAt = nowSeconds();
  persistRetentionSummary(summary);
  return summary;
}

/**
 * Nightly cleanup: delete `jobs` rows older than `job_row_retention_days`.
 */
export async function runNightlyCleanup(cfg?: RetentionConfig): Promise<NightlyRetentionSummary> {
  const startedAt = nowSeconds();
  const summary: NightlyRetentionSummary = {
    type: 'nightly',
    status: 'completed',
    startedAt,
    finishedAt: startedAt,
    rowsScanned: 0,
    rowsDeleted: 0,
    skippedRunningRows: 0,
    errorCount: 0,
    lastError: null,
  };
  const settings = cfg ?? getSettings();
  const { job_row_retention_days } = settings;

  if (job_row_retention_days <= 0) {
    summary.status = 'disabled';
    summary.finishedAt = nowSeconds();
    persistRetentionSummary(summary);
    return summary;
  }

  const cutoffTs = nowSeconds() - job_row_retention_days * 86400;

  try {
    const oldFinishedRows = await db.select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(isNotNull(schema.jobs.finishedAt), lt(schema.jobs.startedAt, cutoffTs)));
    summary.rowsScanned = oldFinishedRows.length;

    const skippedRows = await db.select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(isNull(schema.jobs.finishedAt), lt(schema.jobs.startedAt, cutoffTs)));
    summary.skippedRunningRows = skippedRows.length;

    const result = await db.delete(schema.jobs)
      .where(and(isNotNull(schema.jobs.finishedAt), lt(schema.jobs.startedAt, cutoffTs)))
      .execute();
    summary.rowsDeleted = result.rowCount ?? oldFinishedRows.length;
    // Prune resource samples for the same horizon. Samples for jobs whose
    // rows just got deleted are orphans anyway; samples for older runs
    // we kept (still-running past cutoff) are pruned by sampledAt < cutoff
    // independently so the time series doesn't grow unbounded.
    try {
      await db.delete(schema.jobResourceSamples)
        .where(lt(schema.jobResourceSamples.sampledAt, cutoffTs))
        .execute();
    } catch (e) {
      console.error('[retention] resource-samples prune failed:', e);
    }
  } catch (e) {
    summary.status = 'failed';
    summary.errorCount += 1;
    summary.lastError = errorMessage(e);
    console.error('[retention] nightly cleanup failed:', e);
  }

  summary.finishedAt = nowSeconds();
  persistRetentionSummary(summary);
  return summary;
}
