// Regression for the lifecycle.ts agent-actions hook silently failing when
// it passed `job.logPath` to `extractAssistantTextFromRawLog` instead of the
// log's *contents*. The extractor split the path string by '\n', got one
// non-JSON line, returned "", the parser reported `missing`, and the
// orchestrator never ran — so `issue-close` actions went un-executed and
// issues stayed open. The fix reads the log file before extracting.
//
// This test runs the same chain (read → extract → parse) against a synthetic
// stream-json log that mirrors what the Claude shim writes to disk, plus the
// exact tamtam-actions block the issue-cruncher agent emitted in the wild.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractAssistantTextFromRawLog } from '@/lib/agents/work-summary-extractor.mjs';
import { parseAgentActions } from '@/lib/agents/action-block-parser';

function makeStreamJsonLog(assistantText: string): string {
  // One content_block_start (text), one content_block_delta (text_delta), one
  // content_block_stop, then the final result event the shim emits on
  // turn-complete. Mirrors what the parser actually sees on disk.
  const lines = [
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: assistantText } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, session_id: 's', result: '' }),
  ];
  return lines.join('\n');
}

describe('agent-actions extraction from raw log file', () => {
  it('reads log, extracts assistant text, and parses an issue-close + checkout-default block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-agent-actions-'));
    try {
      const logPath = join(dir, 'job.log');
      const assistantText = [
        'TamTam Run Report',
        'Summary: Closed issue #321 as not planned because its acceptance criteria depend on disabled analytics.',
        'Files changed: none',
        'Actionable work: no',
        '',
        '```tamtam-actions',
        JSON.stringify({
          actions: [
            { type: 'issue-close', number: 321, reason: 'not planned', comment: 'Bundled cross-cutting initiative, reopen as smaller scoped issues.' },
            { type: 'checkout-default' },
          ],
        }, null, 2),
        '```',
      ].join('\n');
      writeFileSync(logPath, makeStreamJsonLog(assistantText));

      // Exact same call sequence as the lifecycle hook (post-fix).
      const rawLog = readFileSync(logPath, 'utf8');
      const text = extractAssistantTextFromRawLog(rawLog);
      const parsed = parseAgentActions(text);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return; // narrow
      expect(parsed.actions).toHaveLength(2);
      expect(parsed.actions[0]).toMatchObject({
        type: 'issue-close',
        number: 321,
        reason: 'not planned',
      });
      expect(parsed.actions[1]).toMatchObject({ type: 'checkout-default' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns "missing" when the lifecycle hook is mistakenly given a path instead of contents', () => {
    // The pre-fix bug, encoded as a test so any regression surfaces fast.
    // Passing the path string returns an empty text from the extractor; the
    // parser then reports `missing`, the orchestrator silently skips. This
    // is exactly the state issue #321 was left in.
    const text = extractAssistantTextFromRawLog('/Users/tamtam/data/logs/some-job.log');
    expect(text).toBe('');
    const parsed = parseAgentActions(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('missing');
  });
});
