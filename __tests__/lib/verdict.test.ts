import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readLog, readParsedLog, getVerdict } from '@/lib/jobs/verdict';
import type { JobData } from '@/lib/jobs/types';

// Plain text written to a log file won't parse as NDJSON, so parseStreamLines
// returns no events and readParsedLog falls back to the raw content — which is
// exactly what we want for testing computeVerdict without mocking internals.

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'verdict-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function writeLog(content: string): string {
  const path = join(dir, `job-${counter++}.log`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: `job-${counter++}`,
    project: 'proj1',
    kind: 'review',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

// NDJSON stream event line for text content — matches what Claude CLI emits.
function ndjsonText(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  });
}

// ─── getVerdict guards ───────────────────────────────────────────────────────

describe('getVerdict — guards', () => {
  it('returns null for non-review job kinds', () => {
    const job = makeJob({ kind: 'fix', logPath: writeLog('Verdict: LGTM') });
    expect(getVerdict(job)).toBeNull();
  });

  it('returns null when finishedAt is null (job still running)', () => {
    const job = makeJob({ finishedAt: null, logPath: writeLog('Verdict: LGTM') });
    expect(getVerdict(job)).toBeNull();
  });

  it('returns null when logPath is null', () => {
    const job = makeJob({ logPath: null });
    expect(getVerdict(job)).toBeNull();
  });

  it('returns null when file does not exist', () => {
    const job = makeJob({ logPath: join(dir, 'nonexistent.log') });
    expect(getVerdict(job)).toBeNull();
  });

  it('returns null when log is empty', () => {
    const job = makeJob({ logPath: writeLog('') });
    expect(getVerdict(job)).toBeNull();
  });

  it('memoizes the verdict after the first read', () => {
    const path = writeLog('Verdict: LGTM');
    const job = makeJob({ logPath: path });

    const first = getVerdict(job);
    // Overwrite the file — the cache should still return the original
    writeFileSync(path, 'DO NOT SHIP', 'utf-8');
    const second = getVerdict(job);

    expect(first).toBe('LGTM');
    expect(second).toBe('LGTM'); // cached, not re-read
  });
});

// ─── getVerdict multiline header detection ───────────────────────────────────

describe('getVerdict — multiline "Verdict:" header detection', () => {
  function job(content: string): JobData {
    return makeJob({ logPath: writeLog(content) });
  }

  it('detects "Verdict: LGTM"', () => {
    expect(getVerdict(job('Review complete.\nVerdict: LGTM'))).toBe('LGTM');
  });

  it('detects "Verdict: NEEDS ATTENTION"', () => {
    expect(getVerdict(job('Verdict: NEEDS ATTENTION'))).toBe('NEEDS ATTENTION');
  });

  it('detects "Verdict: DO NOT SHIP"', () => {
    expect(getVerdict(job('Verdict: DO NOT SHIP'))).toBe('DO NOT SHIP');
  });

  it('detects lowercase "verdict: LGTM"', () => {
    expect(getVerdict(job('verdict: LGTM'))).toBe('LGTM');
  });

  it('detects markdown heading "## Verdict\\n**LGTM**"', () => {
    expect(getVerdict(job('## Verdict\n**LGTM**'))).toBe('LGTM');
  });

  it('detects "Verdict\\n\\nLGTM" with blank-line separator', () => {
    expect(getVerdict(job('Verdict\n\nLGTM'))).toBe('LGTM');
  });

  it('detects "Verdict — NEEDS ATTENTION" with em-dash', () => {
    expect(getVerdict(job('Verdict — NEEDS ATTENTION'))).toBe('NEEDS ATTENTION');
  });

  it('uses the LAST occurrence when multiple verdict headers appear', () => {
    expect(getVerdict(job('Verdict: LGTM\n\nsome code\n\nVerdict: DO NOT SHIP'))).toBe('DO NOT SHIP');
  });

  it('rejects prompt enum "LGTM / NEEDS ATTENTION / DO NOT SHIP" and picks real verdict', () => {
    const content = 'Options: Verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP\n\nVerdict: NEEDS ATTENTION';
    expect(getVerdict(job(content))).toBe('NEEDS ATTENTION');
  });
});

// ─── getVerdict line fallback detection ─────────────────────────────────────

describe('getVerdict — line fallback (no Verdict: header)', () => {
  function job(content: string): JobData {
    return makeJob({ logPath: writeLog(content) });
  }

  it('detects bare LGTM on final line', () => {
    expect(getVerdict(job('Some review text.\nLGTM'))).toBe('LGTM');
  });

  it('detects **LGTM** with bold markdown decoration', () => {
    expect(getVerdict(job('Summary.\n**LGTM**'))).toBe('LGTM');
  });

  it('detects "LGTM — minor issues noted" with em-dash rationale', () => {
    expect(getVerdict(job('Check done.\nLGTM — minor issues noted'))).toBe('LGTM');
  });

  it('detects "NEEDS ATTENTION: explanation" with colon + rationale', () => {
    expect(getVerdict(job('Summary:\nNEEDS ATTENTION: fix the null check'))).toBe('NEEDS ATTENTION');
  });

  it('detects "DO NOT SHIP" on final line', () => {
    expect(getVerdict(job('Critical bug found.\nDO NOT SHIP'))).toBe('DO NOT SHIP');
  });

  it('returns null when no verdict token appears', () => {
    expect(getVerdict(job('The code looks good but has some concerns.'))).toBeNull();
  });

  it('rejects "LGTM / NEEDS ATTENTION / DO NOT SHIP" prompt enum on its own line', () => {
    expect(getVerdict(job('Output one of: LGTM / NEEDS ATTENTION / DO NOT SHIP'))).toBeNull();
  });
});

// ─── getVerdict tail-only search ─────────────────────────────────────────────

describe('getVerdict — only searches last 2000 chars', () => {
  it('ignores a verdict token buried more than 2000 chars before the end', () => {
    // "Verdict: LGTM" is 14 chars; 2500 neutral chars after it puts it outside
    // the 2000-char tail window that computeVerdict inspects.
    const preamble = 'Verdict: LGTM\n';
    const filler = 'a'.repeat(2500);
    const logPath = writeLog(preamble + filler);
    expect(getVerdict(makeJob({ logPath }))).toBeNull();
  });

  it('finds a verdict appearing within the last 2000 characters', () => {
    const preamble = 'x'.repeat(3000); // well past 2000 chars
    const tail = '\nVerdict: DO NOT SHIP';
    const logPath = writeLog(preamble + tail);
    expect(getVerdict(makeJob({ logPath }))).toBe('DO NOT SHIP');
  });
});

// ─── getVerdict with NDJSON stream-json logs ─────────────────────────────────

describe('getVerdict — reads verdict from parsed NDJSON stream', () => {
  it('extracts verdict from text event in NDJSON log', () => {
    const ndjson = ndjsonText('Code review complete.\nVerdict: LGTM');
    const logPath = writeLog(ndjson);
    expect(getVerdict(makeJob({ logPath }))).toBe('LGTM');
  });

  it('extracts NEEDS ATTENTION from multi-event NDJSON log', () => {
    const ndjson = [
      ndjsonText('Reviewing the diff...\n'),
      ndjsonText('Found issues.\n'),
      ndjsonText('Verdict: NEEDS ATTENTION'),
    ].join('\n');
    const logPath = writeLog(ndjson);
    expect(getVerdict(makeJob({ logPath }))).toBe('NEEDS ATTENTION');
  });
});

// ─── readLog edge cases ───────────────────────────────────────────────────────

describe('readLog', () => {
  it('returns empty string when logPath is null', () => {
    expect(readLog(makeJob({ logPath: null }))).toBe('');
  });

  it('returns empty string when file does not exist', () => {
    expect(readLog(makeJob({ logPath: join(dir, 'missing.log') }))).toBe('');
  });

  it('returns full content when under the tailBytes limit', () => {
    const logPath = writeLog('short content');
    expect(readLog(makeJob({ logPath }))).toBe('short content');
  });

  it('trims to tailBytes and aligns to newline boundary', () => {
    // 21 chars total: "aaa\nbbb\nccc\nddd\neee\n"
    // With tailBytes=12, tail is "ddd\neee\n" (last 9 chars after newline alignment)
    const logPath = writeLog('aaa\nbbb\nccc\nddd\neee\n');
    const result = readLog(makeJob({ logPath }), 12);
    expect(result).not.toContain('aaa');
    expect(result).not.toContain('bbb');
    expect(result).toContain('eee');
  });
});

// ─── readParsedLog event parsing ─────────────────────────────────────────────

describe('readParsedLog', () => {
  it('returns empty string when log is empty', () => {
    const logPath = writeLog('');
    expect(readParsedLog(makeJob({ logPath }))).toBe('');
  });

  it('falls back to raw content when no text events parsed', () => {
    // plain text is not valid NDJSON → parseStreamLines yields nothing
    const logPath = writeLog('plain text content');
    expect(readParsedLog(makeJob({ logPath }))).toBe('plain text content');
  });

  it('returns joined text from NDJSON text events', () => {
    const ndjson = [ndjsonText('Hello '), ndjsonText('world')].join('\n');
    const logPath = writeLog(ndjson);
    expect(readParsedLog(makeJob({ logPath }))).toBe('Hello world');
  });

  it('includes tool_use annotation line', () => {
    // tool_use requires: content_block_start (type=tool_use) then content_block_stop
    const startLine = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Read' } },
    });
    const stopLine = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    });
    const logPath = writeLog([ndjsonText('before'), startLine, stopLine].join('\n'));
    const result = readParsedLog(makeJob({ logPath }));
    expect(result).toContain('Tool: Read');
  });

  it('truncates long tool_result content with ellipsis', () => {
    const longContent = 'x'.repeat(600);
    // tool_result comes via system event with subtype tool_result
    const toolResultLine = JSON.stringify({
      type: 'system',
      subtype: 'tool_result',
      content: longContent,
    });
    const logPath = writeLog([ndjsonText('start'), toolResultLine].join('\n'));
    const result = readParsedLog(makeJob({ logPath }));
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(700);
  });
});
