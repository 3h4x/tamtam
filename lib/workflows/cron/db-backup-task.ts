// graphile-worker task: db-backup
//
// Fires every 15 minutes. Snapshots the live Postgres DB to a custom-format
// pg_dump under `data/db/`, then prunes old backups per
// `backup_retention_count` / `backup_retention_weekly_count` settings.
//
// Self-reenqueues so the chain survives Next.js restarts. Mirrors the
// project-sweep pattern.

import type { JobHelpers, Task } from 'graphile-worker';

/** Fallback when settings can't be loaded — keeps the chain alive even if
 *  the config cache is briefly unavailable on boot. */
export const DB_BACKUP_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
export const DB_BACKUP_JOB_KEY = 'db-backup';

export interface DbBackupResult {
  ran: boolean;
  backupPath?: string;
  pruned?: string[];
  error?: string;
  nextFireAt: Date;
  skipped?: 'disabled';
}

export interface DbBackupDeps {
  createBackup: () => Promise<string>;
  pruneOld: () => Promise<string[]>;
  enqueueNextFire: (runAt: Date) => Promise<void>;
  /** Returns the current backup config. cron re-reads on every fire so
   *  the operator can toggle the cadence / disable without a restart. */
  readConfig: () => Promise<{ enabled: boolean; intervalMs: number }> | { enabled: boolean; intervalMs: number };
  now?: () => number;
}

export async function handleDbBackup(deps: DbBackupDeps): Promise<DbBackupResult> {
  const now = deps.now ?? Date.now;
  let cfg: { enabled: boolean; intervalMs: number };
  try {
    cfg = await deps.readConfig();
  } catch {
    cfg = { enabled: true, intervalMs: DB_BACKUP_DEFAULT_INTERVAL_MS };
  }

  let ran = false;
  let backupPath: string | undefined;
  let pruned: string[] | undefined;
  let error: string | undefined;
  let skipped: 'disabled' | undefined;

  if (!cfg.enabled) {
    skipped = 'disabled';
  } else {
    try {
      backupPath = await deps.createBackup();
      ran = true;
      try {
        pruned = await deps.pruneOld();
      } catch (pruneErr) {
        // Pruning is best-effort — a failed prune shouldn't break the backup.
        error = `prune failed: ${pruneErr instanceof Error ? pruneErr.message : String(pruneErr)}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const nextFireAt = new Date(now() + cfg.intervalMs);
  await deps.enqueueNextFire(nextFireAt);
  return { ran, backupPath, pruned, error, nextFireAt, skipped };
}

export function createDbBackupTask(deps: DbBackupDeps): Task {
  return async (_payload, helpers: JobHelpers) => {
    const r = await handleDbBackup(deps);
    if (r.skipped === 'disabled') {
      helpers.logger.info(`db-backup: skipped (disabled); next fire ${r.nextFireAt.toISOString()}`);
    } else if (r.error && !r.ran) {
      helpers.logger.error(`db-backup: ${r.error}; re-enqueued at ${r.nextFireAt.toISOString()}`);
    } else if (r.error) {
      helpers.logger.warn(`db-backup: ${r.backupPath} (prune warn: ${r.error}); next fire ${r.nextFireAt.toISOString()}`);
    } else if (r.ran) {
      helpers.logger.info(`db-backup: ${r.backupPath}${r.pruned?.length ? ` (pruned ${r.pruned.length})` : ''}; next fire ${r.nextFireAt.toISOString()}`);
    } else {
      helpers.logger.info(`db-backup: skipped, next fire ${r.nextFireAt.toISOString()}`);
    }
  };
}
