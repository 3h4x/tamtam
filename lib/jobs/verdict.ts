import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import { parseStreamLines } from './claude-stream-parser';
import type { JobData } from './types';

export function readLog(job: JobData, tailBytes = 100_000): string {
  if (!job.logPath || !existsSync(/*turbopackIgnore: true*/ job.logPath)) return '';
  // Tail-read via fd instead of `readFileSync(path)` + `slice(-tailBytes)` —
  // the old form allocated the entire file (multi-MB review logs are common)
  // just to throw away everything before the tail. Mirrors `readLogHead` and
  // the iter 86 / iter 106 fd-bound tail pattern.
  let fd: number | null = null;
  try {
    fd = openSync(/*turbopackIgnore: true*/ job.logPath, 'r');
    const size = fstatSync(fd).size;
    if (size <= 0) return '';
    if (size <= tailBytes) {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8');
    }
    const start = size - tailBytes;
    const buf = Buffer.alloc(tailBytes);
    const bytesRead = readSync(fd, buf, 0, tailBytes, start);
    const tail = buf.toString('utf8', 0, bytesRead);
    const newlineIdx = tail.indexOf('\n');
    return newlineIdx >= 0 ? tail.slice(newlineIdx + 1) : tail;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}

export function readLogHead(job: JobData, headBytes = 4096): string {
  if (!job.logPath) return '';
  let fd: number | null = null;
  try {
    fd = openSync(/*turbopackIgnore: true*/ job.logPath, 'r');
    const buffer = Buffer.alloc(headBytes);
    const bytesRead = readSync(fd, buffer, 0, headBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
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
      if (event.result.error && event.result.errorText) {
        textParts.push(event.result.errorText);
      }
      // Cost/duration stored in DB, not shown inline
    }
  }

  // If we extracted text, return it; otherwise return raw log
  if (textParts.length > 0) {
    return textParts.join('');
  }

  return rawLog;
}

export function readDisplayLog(job: JobData, tailBytes = 100_000): string {
  const rawLog = readLog(job, tailBytes);
  if (!rawLog) return '';

  const textParts: string[] = [];
  const events = parseStreamLines(rawLog, {
    onRawLine: (line) => {
      textParts.push(`${line}\n`);
    },
  });

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
      if (event.result.error && event.result.errorText) {
        textParts.push(event.result.errorText);
      }
    }
  }

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
//
// IMPORTANT: only successful parses are cached. Caching `null` is unsafe
// because the log file may not have been fully flushed when getVerdict is
// first called right after markDone — a single transient miss would then
// poison the cache for the whole process lifetime, which is exactly what
// drove the live "59% parseFailed" rate seen in the issue.
const verdictCache = new Map<string, string>();

export function getVerdict(job: JobData): string | null {
  if (job.kind !== 'review' || job.finishedAt === null) return null;
  // Stored verdict survives log pruning — use it directly when present.
  if (job.verdict) return job.verdict;
  const cached = verdictCache.get(job.id);
  if (cached !== undefined) return cached;
  const v = computeVerdict(job);
  if (v !== null) verdictCache.set(job.id, v);
  return v;
}

// Strip markdown emphasis, code-fence/backtick remnants, list markers, and
// surrounding whitespace so a decorated token like "  **`LGTM`** ." reduces
// to the bare word for matching.
function stripDecoration(s: string): string {
  return s
    .replace(/^[\s>*_`#\-•]+/, '')
    .replace(/[\s*_`.,;!?]+$/, '')
    .trim();
}

const CANON_TOKENS: Record<string, string> = {
  LGTM: 'LGTM',
  'NEEDS ATTENTION': 'NEEDS ATTENTION',
  'DO NOT SHIP': 'DO NOT SHIP',
};

// Last-resort synonym map. Models occasionally substitute these when the
// verdict prompt instructions are buried under a long reasoning trace.
// Only consulted if every "real" pattern fails — emits a debug log so we can
// monitor drift over time.
const SYNONYMS: Record<string, string> = {
  APPROVE: 'LGTM',
  APPROVED: 'LGTM',
  SHIP: 'LGTM',
  'SHIP IT': 'LGTM',
  BLOCK: 'DO NOT SHIP',
  BLOCKED: 'DO NOT SHIP',
  REJECT: 'DO NOT SHIP',
  REJECTED: 'DO NOT SHIP',
  CHANGES: 'NEEDS ATTENTION',
  'CHANGES REQUESTED': 'NEEDS ATTENTION',
  'REQUEST CHANGES': 'NEEDS ATTENTION',
  REQUEST_CHANGES: 'NEEDS ATTENTION',
};

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
  if (multiline.length > 0) return CANON_TOKENS[multiline[multiline.length - 1][1]];

  // Fallback 1: scan the final non-empty lines for a verdict token at the
  // start (with optional markdown decoration) followed by either end-of-line
  // or a separator like " — ", ":", " -" introducing a one-line rationale.
  // Accepts bare `LGTM`, `**LGTM**`, `LGTM — summary`, `LGTM: summary`, etc.
  // Rejects `LGTM / NEEDS ATTENTION / DO NOT SHIP` (the prompt's own enum)
  // because that line has a "/" right after the token.
  // Widened from the last 5 lines to the last 8 — models sometimes emit a
  // short closing aside ("That's all I have." / a blank line / a markdown
  // separator) after the verdict line.
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const lineTokenRe = /^[*_`>#\-•\s]*(LGTM|NEEDS ATTENTION|DO NOT SHIP)[*_`]*(?:\s*[-–—:]|\s*$)(?![*_` ]*\s*\/)/;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = lineTokenRe.exec(lines[i]);
    if (m) return CANON_TOKENS[m[1]];
  }

  // Fallback 2: a stripped-decoration final-lines scan. Catches forms like
  // "### LGTM ###", "> **LGTM.**", "`LGTM`" — markdown decoration only,
  // no real text beyond the token.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const stripped = stripDecoration(lines[i]).toUpperCase();
    if (stripped === 'LGTM' || stripped === 'NEEDS ATTENTION' || stripped === 'DO NOT SHIP') {
      return CANON_TOKENS[stripped];
    }
  }

  // Last resort: synonyms. Only checked after every real pattern fails so a
  // model accidentally writing "approve" mid-review doesn't override an
  // explicit verdict elsewhere. Logged once per detection so we can tell
  // whether the new prompt is regressing models toward synonyms.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const stripped = stripDecoration(lines[i]).toUpperCase().replace(/[^A-Z _]/g, '');
    const mapped = SYNONYMS[stripped];
    if (mapped) {
      console.log(`[verdict] synonym fallback for ${job.id}: "${stripped}" → ${mapped}`);
      return mapped;
    }
  }

  return null;
}

/** Test helper — clear the in-memory cache so a test that mutates a log can
 * re-observe the verdict. Not exported in any production path. */
export function _resetVerdictCache(): void {
  verdictCache.clear();
}
