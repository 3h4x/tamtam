import { unlinkSync, existsSync, statSync } from 'fs';
import { lt, and, isNotNull, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';

export interface RetentionConfig {
  log_retention_count: number;
  log_retention_days: number;
  job_row_retention_days: number;
}

type CleanupStatus = 'completed' | 'disabled' | 'failed';
type SqliteMaintenanceStatus = 'completed' | 'skipped' | 'failed';

export interface SqliteMaintenanceSummary {
  status: SqliteMaintenanceStatus;
  startedAt: number;
  finishedAt: number;
  activeJobs: number;
  reason?: string;
  checkpointRan: boolean;
  vacuumRan: boolean;
  error?: string;
}

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
  sqliteMaintenance: SqliteMaintenanceSummary;
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

function getRetentionStatusKey(summary: RetentionSummary): string {
  return summary.type === 'project_logs'
    ? PROJECT_LOG_RETENTION_STATUS_KEY
    : NIGHTLY_RETENTION_STATUS_KEY;
}

function persistRetentionSummary(summary: RetentionSummary): void {
  const key = getRetentionStatusKey(summary);
  try {
    db.insert(schema.maintenanceStatus)
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
      .run();
  } catch (e) {
    console.error('[retention] failed to persist cleanup summary:', e);
  }
}

function readRetentionSummary<T extends RetentionSummary>(key: string): T | null {
  try {
    const row = db.select({ value: schema.maintenanceStatus.value })
      .from(schema.maintenanceStatus)
      .where(eq(schema.maintenanceStatus.key, key))
      .get();
    if (!row) return null;
    return JSON.parse(row.value) as T;
  } catch (e) {
    console.error('[retention] failed to read cleanup summary:', e);
    return null;
  }
}

export function getLatestProjectLogRetentionSummary(): ProjectLogRetentionSummary | null {
  return readRetentionSummary<ProjectLogRetentionSummary>(PROJECT_LOG_RETENTION_STATUS_KEY);
}

export function getLatestNightlyRetentionSummary(): NightlyRetentionSummary | null {
  return readRetentionSummary<NightlyRetentionSummary>(NIGHTLY_RETENTION_STATUS_KEY);
}

function runSqliteMaintenance(rowsDeleted: number): SqliteMaintenanceSummary {
  const startedAt = nowSeconds();
  const base = {
    startedAt,
    finishedAt: startedAt,
    activeJobs: 0,
    checkpointRan: false,
    vacuumRan: false,
  };

  if (rowsDeleted <= 0) {
    return {
      ...base,
      status: 'skipped',
      reason: 'no_deleted_rows',
    };
  }

  try {
    const activeJobs = db.select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(isNull(schema.jobs.finishedAt))
      .all().length;

    if (activeJobs > 0) {
      return {
        ...base,
        finishedAt: nowSeconds(),
        activeJobs,
        status: 'skipped',
        reason: 'active_jobs',
      };
    }

    db.run(sql.raw('PRAGMA wal_checkpoint(TRUNCATE)'));
    db.run(sql.raw('VACUUM'));

    return {
      ...base,
      finishedAt: nowSeconds(),
      status: 'completed',
      checkpointRan: true,
      vacuumRan: true,
    };
  } catch (e) {
    return {
      ...base,
      finishedAt: nowSeconds(),
      status: 'failed',
      reason: 'error',
      error: errorMessage(e),
    };
  }
}

/**
 * Prune old log files for a project after a run completes.
 * Keeps the last `log_retention_count` finished runs per project, and/or
 * runs newer than `log_retention_days`. Deletes on-disk log files and sets
 * `log_pruned=true` on the DB row; the row itself is preserved for history.
 */
export function pruneProjectLogs(project: string, cfg?: RetentionConfig): ProjectLogRetentionSummary {
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

  // Treat 0 (or negative) as "disabled" for either dimension.
  const countEnabled = log_retention_count > 0;
  const ageEnabled = log_retention_days > 0;
  if (!countEnabled && !ageEnabled) {
    summary.status = 'disabled';
    summary.finishedAt = nowSeconds();
    persistRetentionSummary(summary);
    return summary;
  }

  const cutoffTs = ageEnabled ? nowSeconds() - log_retention_days * 86400 : -Infinity;

  const skippedRunningRows = db.select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.project, project), isNull(schema.jobs.finishedAt)))
    .all().length;
  summary.skippedRunningRows = skippedRunningRows;

  // Get all finished jobs for this project, newest first.
  const rows = db
    .select({ id: schema.jobs.id, logPath: schema.jobs.logPath, startedAt: schema.jobs.startedAt, logPruned: schema.jobs.logPruned })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.project, project), isNotNull(schema.jobs.finishedAt)))
    .all()
    .sort((a, b) => b.startedAt - a.startedAt);
  summary.rowsScanned = rows.length;

  const toPrune: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.logPruned) continue;
    const overCount = countEnabled && i >= log_retention_count;
    const overAge = ageEnabled && row.startedAt < cutoffTs;
    if (overCount || overAge) toPrune.push(row.id);
  }
  summary.rowsEligible = toPrune.length;

  for (const id of toPrune) {
    const row = rows.find(r => r.id === id);
    if (!row) continue;
    if (row.logPath && existsSync(row.logPath)) {
      try {
        const size = statSync(row.logPath).size;
        unlinkSync(row.logPath);
        summary.logFilesDeleted += 1;
        summary.bytesReclaimed += size;
      } catch (e) {
        summary.errorCount += 1;
        summary.lastError = errorMessage(e);
      }
    }
    try {
      db.update(schema.jobs)
        .set({ logPruned: true })
        .where(eq(schema.jobs.id, id))
        .run();
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
 * Only removes finished rows (finishedAt IS NOT NULL) to avoid touching
 * running jobs.
 */
export function runNightlyCleanup(cfg?: RetentionConfig): NightlyRetentionSummary {
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
    sqliteMaintenance: {
      status: 'skipped',
      startedAt,
      finishedAt: startedAt,
      activeJobs: 0,
      reason: 'not_started',
      checkpointRan: false,
      vacuumRan: false,
    },
  };
  const settings = cfg ?? getSettings();
  const { job_row_retention_days } = settings;

  // 0 (or negative) disables row deletion entirely.
  if (job_row_retention_days <= 0) {
    summary.status = 'disabled';
    summary.sqliteMaintenance = runSqliteMaintenance(0);
    summary.finishedAt = nowSeconds();
    persistRetentionSummary(summary);
    return summary;
  }

  const cutoffTs = nowSeconds() - job_row_retention_days * 86400;

  try {
    const oldFinishedRows = db.select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(isNotNull(schema.jobs.finishedAt), lt(schema.jobs.startedAt, cutoffTs)))
      .all();
    summary.rowsScanned = oldFinishedRows.length;
    summary.skippedRunningRows = db.select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(isNull(schema.jobs.finishedAt), lt(schema.jobs.startedAt, cutoffTs)))
      .all().length;

    const result = db.delete(schema.jobs)
      .where(and(isNotNull(schema.jobs.finishedAt), lt(schema.jobs.startedAt, cutoffTs)))
      .run();
    summary.rowsDeleted = result.changes ?? oldFinishedRows.length;
    summary.sqliteMaintenance = runSqliteMaintenance(summary.rowsDeleted);
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
