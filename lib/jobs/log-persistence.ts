import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { redactLogFrame } from '@/lib/shared/log-redaction';

export interface LogFrame {
  type: string;
  content: string;
  timestamp: string;
}

function getLogsDir(baseDir?: string): string {
  const base = baseDir ?? homedir();
  const logsDir = join(/*turbopackIgnore: true*/ base, '.tamtam', 'jobs');
  mkdirSync(/*turbopackIgnore: true*/ logsDir, { recursive: true });
  return logsDir;
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

  if (!existsSync(/*turbopackIgnore: true*/ logFile)) return [];

  const frames: LogFrame[] = [];
  const lines = readFileSync(/*turbopackIgnore: true*/ logFile, 'utf-8').split('\n');
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
  if (!existsSync(/*turbopackIgnore: true*/ logsDir)) return;

  const logFiles = readdirSync(/*turbopackIgnore: true*/ logsDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ name: f, mtime: statSync(/*turbopackIgnore: true*/ join(logsDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  if (logFiles.length <= maxLogs) return;

  const toDelete = logFiles.slice(0, logFiles.length - maxLogs);
  for (const file of toDelete) {
    try {
      unlinkSync(/*turbopackIgnore: true*/ join(logsDir, file.name));
    } catch {
      // skip failures
    }
  }
}
