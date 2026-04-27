import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const RUNS_FILE = join(homedir(), '.cache', 'tamtam', 'schedule-runs.jsonl');

export interface RunEntry {
  project: string;
  started: string;
  ended: string | null;
  durationS: number | null;
  exitCode: number | null;
}

export function recordRunStart(project: string): number {
  mkdirSync(dirname(RUNS_FILE), { recursive: true });
  const token = Math.floor(Math.random() * 2 ** 48);
  const rec = {
    e: 'start',
    p: project,
    t: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    pid: token,
    os_pid: process.pid,
  };
  appendFileSync(RUNS_FILE, JSON.stringify(rec) + '\n');
  return token;
}

export function recordRunEnd(project: string, token: number, exitCode: number): void {
  mkdirSync(dirname(RUNS_FILE), { recursive: true });
  const rec = {
    e: 'end',
    p: project,
    t: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    pid: token,
    exit: exitCode,
  };
  appendFileSync(RUNS_FILE, JSON.stringify(rec) + '\n');
  pruneRunsFile();
}

export function pruneRunsFile(keep = 300): void {
  if (!existsSync(RUNS_FILE)) return;
  const lines = readFileSync(RUNS_FILE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length <= keep * 2 + 10) return;

  const starts = new Map<number, string>();
  const completed: [string, string][] = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.e === 'start') {
        starts.set(rec.pid, line.trim());
      } else if (rec.e === 'end') {
        const startLine = starts.get(rec.pid);
        if (startLine) {
          starts.delete(rec.pid);
          completed.push([startLine, line.trim()]);
        }
      }
    } catch {
      continue;
    }
  }

  const kept = completed.slice(-keep);
  const output: string[] = [];
  for (const [s, e] of kept) {
    output.push(s, e);
  }
  for (const s of starts.values()) {
    output.push(s);
  }
  writeFileSync(RUNS_FILE, output.join('\n') + '\n');
}

export function readRunHistory(project?: string, limit = 20): RunEntry[] {
  if (!existsSync(RUNS_FILE)) return [];

  interface StartRec { e: 'start'; p: string; t: string; pid: number; os_pid: number | null }
  const starts = new Map<number, StartRec>();
  const completed: RunEntry[] = [];

  const lines = readFileSync(RUNS_FILE, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.e === 'start') {
        starts.set(rec.pid, rec);
      } else if (rec.e === 'end') {
        const start = starts.get(rec.pid);
        if (start) {
          starts.delete(rec.pid);
          const startedDate = new Date(start.t);
          const endedDate = new Date(rec.t);
          completed.push({
            project: rec.p,
            started: start.t,
            ended: rec.t,
            durationS: Math.floor((endedDate.getTime() - startedDate.getTime()) / 1000),
            exitCode: rec.exit ?? -1,
          });
        }
      }
    } catch {
      continue;
    }
  }

  // Still-running entries
  for (const [, start] of starts) {
    let alive = false;
    const osPid = start.os_pid;
    if (osPid != null) {
      try {
        process.kill(osPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    completed.push({
      project: start.p,
      started: start.t,
      ended: alive ? null : start.t,
      durationS: null,
      exitCode: alive ? null : -1,
    });
  }

  completed.sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime());

  let filtered = completed;
  if (project) {
    filtered = completed.filter(
      (r) => r.project === project || r.project.startsWith(project + '-')
    );
  }

  return filtered.slice(0, limit);
}

export function lastRunLookup(): Record<string, RunEntry> {
  const allRuns = readRunHistory(undefined, 1000);
  const seen: Record<string, RunEntry> = {};
  for (const run of allRuns) {
    if (!(run.project in seen)) {
      seen[run.project] = run;
    }
  }
  return seen;
}
