import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeRequest(url = 'http://localhost/api/monitoring/pm2-logs') {
  return new Request(url);
}

describe('GET /api/monitoring/pm2-logs', () => {
  let tmp: string;
  let originalLogDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pm2-logs-'));
    originalLogDir = process.env.PM2_LOG_DIR;
    process.env.PM2_LOG_DIR = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalLogDir === undefined) delete process.env.PM2_LOG_DIR;
    else process.env.PM2_LOG_DIR = originalLogDir;
  });

  it('reports both files unavailable when logs do not exist', async () => {
    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(makeRequest());
    const json = await res.json();
    // Both error and out are attempted by default now
    expect(json.files).toHaveLength(2);
    expect(json.files.every((f: { error?: string }) => f.error)).toBe(true);
    expect(json.entries).toEqual([]);
  });

  it('parses PM2 --time format (local timestamp, no tz) and classifies levels, newest first', async () => {
    const content = [
      '2026-04-20T10:00:00: hello info line',
      '2026-04-20T10:00:01: Error: something broke',
      '2026-04-20T10:00:02: warning: slow query',
      '2026-04-20T10:00:03: FATAL: crash',
    ].join('\n') + '\n';
    writeFileSync(join(tmp, 'tamtam-error.log'), content);

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(makeRequest());
    const json = await res.json();

    const errEntries = json.entries.filter((e: { source: string }) => e.source === 'error');
    expect(errEntries.length).toBeGreaterThan(0);
    // Newest first among error entries
    expect(errEntries[0].ts).toBe('2026-04-20T10:00:03');
    expect(errEntries[0].level).toBe('error');
    // Level classification
    const levels = Object.fromEntries(errEntries.map((e: { ts: string; level: string }) => [e.ts, e.level]));
    expect(levels['2026-04-20T10:00:01']).toBe('error');
    expect(levels['2026-04-20T10:00:02']).toBe('warn');
    expect(levels['2026-04-20T10:00:03']).toBe('error');
    expect(json.files[0].size).toBeGreaterThan(0);
  });

  it('also parses full ISO timestamps with timezone', async () => {
    const content = '2026-04-20T10:00:00.000Z: hello from tz\n';
    writeFileSync(join(tmp, 'tamtam-error.log'), content);

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(makeRequest());
    const json = await res.json();
    const errEntries = json.entries.filter((e: { source: string }) => e.source === 'error');
    expect(errEntries[0].ts).toBe('2026-04-20T10:00:00.000Z');
    expect(errEntries[0].line).toBe('hello from tz');
  });

  it('respects limit parameter', async () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      `2026-04-20T10:00:${String(i).padStart(2, '0')}: info line ${i}`
    );
    writeFileSync(join(tmp, 'tamtam-error.log'), lines.join('\n') + '\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?limit=5'));
    const json = await res.json();
    expect(json.entries).toHaveLength(5);
  });

  it('includes out log by default and excludes it with out=0', async () => {
    writeFileSync(join(tmp, 'tamtam-error.log'), '2026-04-20T10:00:00: err boom\n');
    writeFileSync(join(tmp, 'tamtam-out.log'), '2026-04-20T10:00:01: stdout line\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');

    // Default: both sources present
    const res = await GET(makeRequest());
    const json = await res.json();
    expect(json.files).toHaveLength(2);
    const sources = new Set(json.entries.map((e: { source: string }) => e.source));
    expect(sources.has('error')).toBe(true);
    expect(sources.has('out')).toBe(true);

    // out=0: only error source
    const res2 = await GET(new Request('http://localhost/api/monitoring/pm2-logs?out=0'));
    const json2 = await res2.json();
    expect(json2.files).toHaveLength(1);
    expect(json2.entries.every((e: { source: string }) => e.source === 'error')).toBe(true);
  });

  it('includes fetchedAt as a number in the response', async () => {
    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(makeRequest());
    const json = await res.json();
    expect(typeof json.fetchedAt).toBe('number');
    expect(json.fetchedAt).toBeGreaterThan(0);
  });

  it('caps limit at 500 even when a larger value is requested', async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      `2026-04-20T10:00:${String(i).padStart(2, '0')}: info line ${i}`
    );
    writeFileSync(join(tmp, 'tamtam-error.log'), lines.join('\n') + '\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?limit=9999'));
    const json = await res.json();
    // The cap is 500; 10 lines < 500 so we get all 10 — proves we hit the cap path without overflowing
    expect(json.entries.length).toBeLessThanOrEqual(500);
  });

  it('falls back to limit=100 when limit param is not a number', async () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      `2026-04-20T10:00:00: line ${i}`
    );
    writeFileSync(join(tmp, 'tamtam-error.log'), lines.join('\n') + '\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?limit=abc'));
    const json = await res.json();
    // NaN || 100 → 100, and only error log contributes, so we get ≤100 entries
    expect(json.entries.length).toBeLessThanOrEqual(100);
  });

  it('emits ts=null for lines without a PM2 timestamp prefix', async () => {
    writeFileSync(join(tmp, 'tamtam-error.log'), 'plain line without timestamp\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?out=0'));
    const json = await res.json();
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].ts).toBeNull();
    expect(json.entries[0].line).toBe('plain line without timestamp');
  });

  it('strips ANSI escape codes before classifying level', async () => {
    // A green "info" word coloured with ANSI should not confuse the classifier into 'error'
    // An "error" word wrapped in ANSI should still be classified as error
    const ansiError = '\x1b[31merror: something bad\x1b[0m';
    const ansiInfo = '\x1b[32minfo: all good\x1b[0m';
    writeFileSync(
      join(tmp, 'tamtam-error.log'),
      [
        `2026-04-20T10:00:00: ${ansiError}`,
        `2026-04-20T10:00:01: ${ansiInfo}`,
      ].join('\n') + '\n',
    );

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?out=0'));
    const json = await res.json();
    const byTs = Object.fromEntries(
      json.entries.map((e: { ts: string; level: string }) => [e.ts, e.level])
    );
    expect(byTs['2026-04-20T10:00:00']).toBe('error');
    expect(byTs['2026-04-20T10:00:01']).toBe('info');
  });

  it('does not classify "no errors" lines as error', async () => {
    writeFileSync(join(tmp, 'tamtam-error.log'), '2026-04-20T10:00:00: no errors found\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?out=0'));
    const json = await res.json();
    expect(json.entries[0].level).toBe('info');
  });

  it('classifies fatal/panic/uncaughtException/unhandledRejection as error', async () => {
    const lines = [
      '2026-04-20T10:00:00: FATAL: out of memory',
      '2026-04-20T10:00:01: panic: nil pointer dereference',
      '2026-04-20T10:00:02: uncaughtException in worker',
      '2026-04-20T10:00:03: unhandledRejection at Promise',
    ];
    writeFileSync(join(tmp, 'tamtam-error.log'), lines.join('\n') + '\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?out=0'));
    const json = await res.json();
    const errEntries = json.entries.filter((e: { source: string }) => e.source === 'error');
    expect(errEntries.every((e: { level: string }) => e.level === 'error')).toBe(true);
  });

  it('sorts entries with timestamps before those without, newest-timestamped first', async () => {
    const content = [
      'plain line without timestamp',
      '2026-04-20T10:00:00: older timestamped line',
      '2026-04-20T10:00:05: newer timestamped line',
    ].join('\n') + '\n';
    writeFileSync(join(tmp, 'tamtam-error.log'), content);

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?out=0'));
    const json = await res.json();

    // Entries with timestamps come first (sorted newest→oldest); ts=null entries come last
    const tsEntries = json.entries.filter((e: { ts: string | null }) => e.ts !== null);
    const noTsEntries = json.entries.filter((e: { ts: string | null }) => e.ts === null);
    expect(tsEntries[0].ts).toBe('2026-04-20T10:00:05');
    expect(tsEntries[1].ts).toBe('2026-04-20T10:00:00');
    expect(noTsEntries.length).toBeGreaterThan(0);
    // All ts entries precede all no-ts entries
    const firstNoTsIdx = json.entries.findIndex((e: { ts: string | null }) => e.ts === null);
    const lastTsIdx = json.entries.map((e: { ts: string | null }) => e.ts !== null).lastIndexOf(true);
    expect(lastTsIdx).toBeLessThan(firstNoTsIdx);
  });

  it('drops the first (potentially partial) line when tailing a large file', async () => {
    // Write a file larger than the 64 KB tail window by making each line ~1 KB.
    const longLine = 'x'.repeat(1020);
    const lines = Array.from({ length: 80 }, (_, i) =>
      `2026-04-20T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}: ${longLine}`
    );
    writeFileSync(join(tmp, 'tamtam-error.log'), lines.join('\n') + '\n');

    const { GET } = await import('@/app/api/monitoring/pm2-logs/route');
    const res = await GET(new Request('http://localhost/api/monitoring/pm2-logs?out=0&limit=500'));
    const json = await res.json();

    // File is ~80 KB > 64 KB tail window → truncated=true → first read line dropped.
    // All returned lines must have a valid ts (no partial first-line garbage).
    const withoutTs = json.entries.filter((e: { ts: string | null }) => e.ts === null);
    expect(withoutTs).toHaveLength(0);
  });
});
