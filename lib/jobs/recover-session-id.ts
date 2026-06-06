import { parseStreamLines } from './claude-stream-parser';
import { readLog, readLogHead } from './job-storage';
import type { JobData } from './types';

const RESUME_RE = /--resume\s+([^\s"]+)/i;
const SESSION_RE = /"session_id":"([^"]+)"/g;

function isRestorableSessionKind(kind: string): boolean {
  return ['run', 'review', 'fix', 'fix-ci'].includes(kind) || kind.startsWith('agent:');
}

export function recoverJobSessionId(job: JobData): string | null {
  if (job.sessionId) return job.sessionId;
  if (!job.logPath || !isRestorableSessionKind(job.kind)) return null;

  const logHead = readLogHead(job, 4096);
  const resumeMatch = RESUME_RE.exec(logHead);
  if (resumeMatch?.[1]) return resumeMatch[1];

  const rawLog = readLog(job, 50_000);
  const events = parseStreamLines(rawLog);
  const doneEvent = events.find((event) => event.type === 'done');
  if (doneEvent?.result.sessionId) {
    return doneEvent.result.sessionId;
  }

  const matches = [...rawLog.matchAll(SESSION_RE)];
  const last = matches.at(-1);
  return last?.[1] ?? null;
}
