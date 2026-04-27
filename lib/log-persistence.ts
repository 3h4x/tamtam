import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface LogFrame {
  type: string;
  content: string;
  timestamp: string;
}

function getLogsDir(baseDir?: string): string {
  const base = baseDir ?? homedir();
  const logsDir = join(base, '.tamtam', 'jobs');
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

export function writeJobLogs(jobId: string, frames: LogFrame[], baseDir?: string): void {
  const logsDir = getLogsDir(baseDir);
  const logFile = join(logsDir, `${jobId}.log`);
  const content = frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(logFile, content);
}

export function readJobLogs(jobId: string, baseDir?: string): LogFrame[] {
  const logsDir = getLogsDir(baseDir);
  const logFile = join(logsDir, `${jobId}.log`);

  if (!existsSync(logFile)) return [];

  const frames: LogFrame[] = [];
  const lines = readFileSync(logFile, 'utf-8').split('\n');
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
  if (!existsSync(logsDir)) return;

  const logFiles = readdirSync(logsDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ name: f, mtime: statSync(join(logsDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  if (logFiles.length <= maxLogs) return;

  const toDelete = logFiles.slice(0, logFiles.length - maxLogs);
  for (const file of toDelete) {
    try {
      unlinkSync(join(logsDir, file.name));
    } catch {
      // skip failures
    }
  }
}
