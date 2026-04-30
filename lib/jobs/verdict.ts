import { existsSync, readFileSync } from 'fs';
import { parseStreamLines } from './claude-stream-parser';
import type { JobData } from './types';

export function readLog(job: JobData, tailBytes = 100_000): string {
  if (!job.logPath || !existsSync(job.logPath)) return '';
  try {
    const content = readFileSync(job.logPath, 'utf-8');
    if (content.length > tailBytes) {
      const tail = content.slice(-tailBytes);
      const newlineIdx = tail.indexOf('\n');
      return newlineIdx >= 0 ? tail.slice(newlineIdx + 1) : tail;
    }
    return content;
  } catch {
    return '';
  }
}

export function readParsedLog(job: JobData, tailBytes = 100_000): string {
  const rawLog = readLog(job, tailBytes);
  if (!rawLog) return '';

  // Try to parse as stream events and extract text
  const events = parseStreamLines(rawLog);
  const textParts: string[] = [];

  for (const event of events) {
    if (event.type === 'text') {
      textParts.push(event.text);
    } else if (event.type === 'tool_use') {
      textParts.push(`\n\n> Tool: ${event.name}\n`);
    } else if (event.type === 'tool_result') {
      const truncated = event.content.length > 500
        ? event.content.slice(0, 500) + '...'
        : event.content;
      textParts.push(`${truncated}\n`);
    } else if (event.type === 'compacting') {
      textParts.push('\n[context compacted]\n');
    } else if (event.type === 'done') {
      // Cost/duration stored in DB, not shown inline
    }
  }

  // If we extracted text, return it; otherwise return raw log
  if (textParts.length > 0) {
    return textParts.join('');
  }

  return rawLog;
}

// Memoize verdict per finished review job. Once a job is finalized its log
// is immutable, so the verdict can't change. /api/jobs polling (every 5 s)
// and the per-row jobToDict were re-reading every review log file from disk
// + re-parsing stream-json on every request — driving the dev server CPU
// to ~800% with hundreds of historical review jobs.
const verdictCache = new Map<string, string | null>();

export function getVerdict(job: JobData): string | null {
  if (job.kind !== 'review' || job.finishedAt === null) return null;
  const cached = verdictCache.get(job.id);
  if (cached !== undefined) return cached;
  const v = computeVerdict(job);
  verdictCache.set(job.id, v);
  return v;
}

function computeVerdict(job: JobData): string | null {
  // Use parsed log — raw stream-json encodes newlines as literal "\n",
  // which breaks word boundaries and masks a trailing verdict token.
  const log = readParsedLog(job, 100_000);
  if (!log) return null;
  // The real verdict is always near the end of the output. Search only the
  // tail to avoid matching code snippets like `verdict === 'LGTM'` or the
  // review prompt's own "Verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP"
  // instructions further up in the log.
  const tail = log.slice(-2000);
  // Multi-line "Verdict\n**X**" form: "Verdict" header followed by a token
  // within a short window of non-alpha characters (whitespace, punctuation,
  // markdown bold, list markers).
  // Reject matches where the verdict is immediately followed by "/" — that's
  // the prompt's own "LGTM / NEEDS ATTENTION / DO NOT SHIP" listing, not a
  // decision.
  const multiline = [...tail.matchAll(/[Vv]erdict[^A-Za-z]{1,80}?(LGTM|NEEDS ATTENTION|DO NOT SHIP)(?![*_` ]*\s*\/)/g)];
  if (multiline.length > 0) return multiline[multiline.length - 1][1];
  // Fallback: scan the final non-empty lines for a verdict token at the
  // start (with optional markdown decoration) followed by either end-of-line
  // or a separator like " — ", ":", " -" introducing a one-line rationale.
  // Accepts bare `LGTM`, `**LGTM**`, `LGTM — summary`, `LGTM: summary`, etc.
  // Rejects `LGTM / NEEDS ATTENTION / DO NOT SHIP` (the prompt's own enum)
  // because that line has a "/" right after the token.
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const lineTokenRe = /^[*_` ]*(LGTM|NEEDS ATTENTION|DO NOT SHIP)[*_` ]*(?:\s*[-–—:]|\s*$)(?![*_` ]*\s*\/)/;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = lineTokenRe.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}
