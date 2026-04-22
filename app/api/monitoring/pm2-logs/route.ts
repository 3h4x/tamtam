import { NextResponse } from 'next/server';
import { statSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface LogEntry {
  ts: string | null;
  level: 'error' | 'warn' | 'info';
  line: string;
  source: 'error' | 'out';
}

const DEFAULT_TAIL_BYTES = 64 * 1024;

// Tail the last N bytes of a file without loading the whole file — the tamtam
// PM2 error log is routinely hundreds of MB, so readFile is not viable.
// Returns { raw, truncated } — truncated=true when we read less than the full file
// and the first line may be partial.
function tailBytes(path: string, bytes: number): { raw: string; truncated: boolean } {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const readLen = Math.min(bytes, size);
    const offset = size - readLen;
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, offset);
    return { raw: buf.toString('utf8'), truncated: offset > 0 };
  } finally {
    closeSync(fd);
  }
}

// PM2 --time prefixes lines as "2026-04-22T08:48:11: message" (local time, no tz).
// Also matches the full ISO variant with timezone for forward-compatibility.
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?): /;

function classify(line: string): 'error' | 'warn' | 'info' {
  // Scrub ANSI color codes before pattern matching so [32m doesn't read as "error".
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (/\b(fatal|panic|uncaughtException|unhandledRejection)\b/i.test(clean)) return 'error';
  if (/\berror\b/i.test(clean) && !/\bno\s+errors?\b/i.test(clean)) return 'error';
  if (/\b(warn|warning)\b/i.test(clean)) return 'warn';
  return 'info';
}

function parseLines(raw: string, source: 'error' | 'out', limit: number, truncated: boolean): LogEntry[] {
  const lines = raw.split('\n');
  // After a mid-file byte-tail the first line is almost certainly partial — drop it.
  // If we read the whole file, keep everything.
  if (truncated) lines.shift();
  const entries: LogEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    const line = lines[i].trimEnd();
    if (!line) continue;
    const m = line.match(TS_RE);
    const ts = m ? m[1] : null;
    // m[0] already includes the ": " separator so we just slice past the full match.
    const text = m ? line.slice(m[0].length) : line;
    entries.push({ ts, level: classify(text), line: text, source });
  }
  return entries;
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 500);
  const logDir = process.env.PM2_LOG_DIR ?? join(homedir(), '.pm2', 'logs');
  // Filenames follow PM2's default convention `<app>-error.log` / `<app>-out.log`,
  // where `<app>` is the fixed PM2 app name ("tamtam") set in package.json's dev/start scripts.
  const errPath = join(logDir, 'tamtam-error.log');
  const outPath = join(logDir, 'tamtam-out.log');

  const entries: LogEntry[] = [];
  const fileStats: { path: string; size: number | null; mtime: string | null; error?: string }[] = [];

  // Always include both logs — the out log carries all scheduler/request activity,
  // the error log carries exceptions. The caller can pass out=0 to suppress stdout.
  const targets: Array<[string, 'error' | 'out']> = [[errPath, 'error']];
  if (searchParams.get('out') !== '0') targets.push([outPath, 'out']);
  for (const [path, source] of targets) {
    try {
      const st = statSync(path);
      fileStats.push({ path, size: st.size, mtime: st.mtime.toISOString() });
      const { raw, truncated } = tailBytes(path, DEFAULT_TAIL_BYTES);
      entries.push(...parseLines(raw, source, limit, truncated));
    } catch (e) {
      fileStats.push({ path, size: null, mtime: null, error: e instanceof Error ? e.message : 'unavailable' });
    }
  }

  // Newest first by timestamp; entries without a timestamp keep file order via stable tail.
  entries.sort((a, b) => {
    if (a.ts && b.ts) return b.ts.localeCompare(a.ts);
    if (a.ts) return -1;
    if (b.ts) return 1;
    return 0;
  });

  return NextResponse.json({
    files: fileStats,
    entries: entries.slice(0, limit),
    fetchedAt: Date.now(),
  });
}
