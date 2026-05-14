import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { errMsg } from '@/lib/shared/types';
import { getSettings } from '@/lib/shared/config';
import {
  createBackupFilename,
  createDatabaseBackup,
  getBackupDirectory,
  pruneBackupFiles,
} from '@/lib/db/backup';

export async function POST(_request: NextRequest) {
  const backupDir = getBackupDirectory();
  const filename = createBackupFilename();
  const backupPath = join(backupDir, filename);

  try {
    await createDatabaseBackup(backupPath);
    const settings = getSettings();
    const pruned = pruneBackupFiles(backupDir, {
      keepRecent: settings.backup_retention_count,
      keepWeekly: settings.backup_retention_weekly_count,
      protectedNames: [filename],
    });
    return NextResponse.json({ status: 'ok', filename, path: backupPath, pruned });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `Backup failed: ${errMsg(e)}` },
      { status: 500 }
    );
  }
}
