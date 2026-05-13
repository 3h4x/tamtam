import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { readdirSync, rmSync, statSync } from 'fs';

export interface BackupFileEntry {
  name: string;
  mtimeMs: number;
}

export interface BackupRetentionOptions {
  keepRecent: number;
  keepWeekly: number;
  protectedNames?: string[];
}

const BACKUP_FILE_RE = /^tamtam-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.db$/;

export function getTamTamDbPath(): string {
  return process.env.TAMTAM_DB_PATH ?? join(process.cwd(), 'data', 'db', 'tamtam.db');
}

export function getBackupDirectory(dbPath = getTamTamDbPath()): string {
  return dirname(dbPath);
}

export function createBackupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `tamtam-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.db`;
}

export function verifySqliteDatabase(dbPath: string): void {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = sqlite.pragma('integrity_check') as Array<Record<string, string>>;
    const integrity = integrityRows.map((row) => Object.values(row)[0]).filter(Boolean);
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new Error(`integrity_check failed: ${integrity.join('; ') || 'no result'}`);
    }

    const foreignKeyRows = sqlite.pragma('foreign_key_check') as Array<Record<string, unknown>>;
    if (foreignKeyRows.length > 0) {
      throw new Error(`foreign_key_check failed: ${foreignKeyRows.length} violation(s)`);
    }
  } finally {
    sqlite.close();
  }
}

export function listBackupFiles(backupDir: string): BackupFileEntry[] {
  return readdirSync(/*turbopackIgnore: true*/ backupDir)
    .filter((name) => BACKUP_FILE_RE.test(name))
    .map((name) => ({
      name,
      mtimeMs: statSync(/*turbopackIgnore: true*/ join(backupDir, name)).mtimeMs,
    }));
}

export function selectBackupsToPrune(
  entries: BackupFileEntry[],
  options: BackupRetentionOptions
): string[] {
  const keepRecent = Math.max(0, options.keepRecent);
  const keepWeekly = Math.max(0, options.keepWeekly);
  const protectedNames = new Set(options.protectedNames ?? []);
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const keep = new Set(sorted.slice(0, keepRecent).map((entry) => entry.name));
  const weeklyKeys = new Set<string>();

  for (const entry of sorted.slice(keepRecent)) {
    if (protectedNames.has(entry.name)) {
      continue;
    }
    const weekKey = getBackupWeekKey(entry.name, entry.mtimeMs);
    if (weeklyKeys.size < keepWeekly && !weeklyKeys.has(weekKey)) {
      weeklyKeys.add(weekKey);
      keep.add(entry.name);
    }
  }

  return sorted
    .filter((entry) => !keep.has(entry.name) && !protectedNames.has(entry.name))
    .map((entry) => entry.name);
}

export function pruneBackupFiles(
  backupDir: string,
  options: BackupRetentionOptions
): string[] {
  const pruned = selectBackupsToPrune(listBackupFiles(backupDir), options);
  for (const name of pruned) {
    removeBackupFileSet(join(backupDir, name));
  }
  return pruned;
}

export function removeBackupFileSet(basePath: string): void {
  for (const path of getBackupFileSetPaths(basePath)) {
    rmSync(/*turbopackIgnore: true*/ path, { force: true });
  }
}

function getBackupWeekKey(name: string, mtimeMs: number): string {
  const match = name.match(BACKUP_FILE_RE);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(mtimeMs);
  const day = date.getDay() || 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 4 - day);
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getFullYear()}-${String(week).padStart(2, '0')}`;
}

function getBackupFileSetPaths(basePath: string): string[] {
  return [basePath, `${basePath}-wal`, `${basePath}-shm`];
}
