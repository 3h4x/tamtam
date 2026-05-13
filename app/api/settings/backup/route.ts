import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { join } from 'path';
import { errMsg } from '@/lib/shared/types';
import { getSettings } from '@/lib/shared/config';
import {
  createBackupFilename,
  getBackupDirectory,
  getTamTamDbPath,
  pruneBackupFiles,
  removeBackupFileSet,
  verifySqliteDatabase,
} from '@/lib/db/backup';

export async function POST(_request: NextRequest) {
  const dbPath = getTamTamDbPath();
  const dbDir = getBackupDirectory(dbPath);
  const filename = createBackupFilename();
  const backupPath = join(dbDir, filename);
  let attemptedBackupWrite = false;

  try {
    verifySqliteDatabase(dbPath);
    const source = new Database(dbPath, { readonly: true });
    try {
      attemptedBackupWrite = true;
      await source.backup(backupPath);
    } finally {
      source.close();
    }
    verifySqliteDatabase(backupPath);
    const settings = getSettings();
    const pruned = pruneBackupFiles(dbDir, {
      keepRecent: settings.backup_retention_count,
      keepWeekly: settings.backup_retention_weekly_count,
      protectedNames: [filename],
    });
    return NextResponse.json({ status: 'ok', filename, path: backupPath, pruned });
  } catch (e: unknown) {
    if (attemptedBackupWrite) {
      try {
        removeBackupFileSet(backupPath);
      } catch {
        // Best-effort cleanup: preserve the original backup error in the response.
      }
    }
    return NextResponse.json(
      { error: `Backup failed: ${errMsg(e)}` },
      { status: 500 }
    );
  }
}
