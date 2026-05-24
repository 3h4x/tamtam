import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { redactLogFrame } from '@/lib/shared/log-redaction';

export interface LogFrame {
  type: string;
  content: string;
  timestamp: string;
}

interface LogFileEntry {
  name: string;
  mtime: number;
  order: number;
}

function getLogsDir(baseDir?: string): string {
  const base = baseDir ?? homedir();
  const logsDir = join(/*turbopackIgnore: true*/ base, '.tamtam', 'jobs');
  mkdirSync(/*turbopackIgnore: true*/ logsDir, { recursive: true });
  return logsDir;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isNewerLogFile(entry: LogFileEntry, current: LogFileEntry): boolean {
  return entry.mtime > current.mtime || (entry.mtime === current.mtime && entry.order > current.order);
}

function insertNewestBounded(
  newest: LogFileEntry[],
  entry: LogFileEntry,
  limit: number,
): LogFileEntry | null {
  let inserted = false;
  for (let i = 0; i < newest.length; i++) {
    const current = newest[i];
    if (current && isNewerLogFile(entry, current)) {
      newest.splice(i, 0, entry);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    if (newest.length >= limit) return entry;
    newest.push(entry);
  }

  return newest.length > limit ? newest.pop() ?? null : null;
}

export function writeJobLogs(jobId: string, frames: LogFrame[], baseDir?: string): void {
  const logsDir = getLogsDir(baseDir);
  const logFile = join(/*turbopackIgnore: true*/ logsDir, `${jobId}.log`);
  const content = frames.map((f) => JSON.stringify(redactLogFrame(f))).join('\n') + '\n';
  writeFileSync(/*turbopackIgnore: true*/ logFile, content);
}

export function readJobLogs(jobId: string, baseDir?: string): LogFrame[] {
  const logsDir = getLogsDir(baseDir);
  const logFile = join(/*turbopackIgnore: true*/ logsDir, `${jobId}.log`);

  let lines: string[];
  try {
    lines = readFileSync(/*turbopackIgnore: true*/ logFile, 'utf-8').split('\n');
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const frames: LogFrame[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return frames;
}

export function cleanupOldLogs(maxLogs = 100, baseDir?: string): void {
  if (maxLogs <= 0) return;
  const logsDir = getLogsDir(baseDir);

  const newest: LogFileEntry[] = [];
  const toDelete: LogFileEntry[] = [];
  let order = 0;
  for (const f of readdirSync(/*turbopackIgnore: true*/ logsDir)) {
    if (!f.endsWith('.log')) continue;
    try {
      const dropped = insertNewestBounded(newest, {
        name: f,
        mtime: statSync(/*turbopackIgnore: true*/ join(logsDir, f)).mtimeMs,
        order,
      }, maxLogs);
      if (dropped) toDelete.push(dropped);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    } finally {
      order += 1;
    }
  }

  for (const file of toDelete) {
    try {
      unlinkSync(/*turbopackIgnore: true*/ join(logsDir, file.name));
    } catch {
      // skip failures
    }
  }
}
