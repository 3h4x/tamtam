import { join } from 'path';
import { readdirSync, rmSync, statSync } from 'fs';
// exec wraps child_process.execFile safely (args are an array, no shell injection risk)
import { exec } from '@/lib/shared/shell';

export interface BackupFileEntry {
  name: string;
  mtimeMs: number;
}

export interface BackupRetentionOptions {
  keepRecent: number;
  keepWeekly: number;
  protectedNames?: string[];
}

const BACKUP_FILE_RE = /^tamtam-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.pgdump$/;

export function getBackupDirectory(): string {
  const envBackupDir = process.env.TAMTAM_BACKUP_DIR;
  if (envBackupDir) return envBackupDir;
  return join(process.cwd(), 'data', 'db');
}

export function createBackupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `tamtam-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.pgdump`;
}

export async function createDatabaseBackup(destPath: string): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('[backup] DATABASE_URL not set');

  const url = new URL(dbUrl);
  const args = [
    '--format=custom',
    `--dbname=${url.pathname.slice(1)}`,
    `--file=${destPath}`,
  ];
  if (url.hostname && url.hostname !== 'localhost' && url.hostname !== '') {
    args.push(`--host=${url.hostname}`);
  }
  if (url.port) args.push(`--port=${url.port}`);
  if (url.username) args.push(`--username=${url.username}`);

  // pg_dump args are an array — no shell injection risk
  const result = await exec('pg_dump', args, { timeout: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(`pg_dump failed (exit ${result.exitCode}): ${result.stderr}`);
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
    if (protectedNames.has(entry.name)) continue;
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
    rmSync(/*turbopackIgnore: true*/ join(backupDir, name), { force: true });
  }
  return pruned;
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
