import { describe, expect, it } from 'vitest';
import {
  extractAssistantTextFromRawLog,
  extractWorkSummary,
} from '@/lib/agents/work-summary-extractor.mjs';

function log(text: string) {
  return [
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 10,
      session_id: 's1',
      result: '',
    }),
  ].join('\n');
}

describe('work-summary-extractor', () => {
  it('extracts assistant text from NDJSON logs with ISO timestamp prefixes', () => {
    const raw = [
      `2026-05-10T10:00:00.000Z: ${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Investigated recent changes.' },
        },
      })}`,
      `2026-05-10T10:00:01.000Z: ${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'No actionable coverage gaps remain.' },
        },
      })}`,
    ].join('\n');

    expect(extractAssistantTextFromRawLog(raw)).toBe(
      'Investigated recent changes.\n\nNo actionable coverage gaps remain.'
    );
  });

  it('extracts the explicit TamTam report summary when present', () => {
    const text = extractAssistantTextFromRawLog(
      log('TamTam Run Report\nSummary: Added focused coverage.\nActionable work: yes\n')
    );

    expect(extractWorkSummary(text)).toEqual({
      summary: 'Added focused coverage.',
      actionable: true,
    });
  });

  it('falls back to the trailing summary block when the report is missing', () => {
    const text = extractAssistantTextFromRawLog(
      log('Investigated recent changes.\n\nNo actionable coverage gaps remain after the latest checks.')
    );

    expect(extractWorkSummary(text)).toEqual({
      summary: 'Investigated recent changes.\n\nNo actionable coverage gaps remain after the latest checks.',
      actionable: null,
    });
  });

  it('stops at narration markers when walking backward through paragraphs', () => {
    const text = extractAssistantTextFromRawLog(
      log("Let me read the file first.\n\nNow I'll fix the bug.\n\nFixed the off-by-one in foo.ts and added a regression test.")
    );

    expect(extractWorkSummary(text)).toEqual({
      summary: 'Fixed the off-by-one in foo.ts and added a regression test.',
      actionable: null,
    });
  });

  it('treats bare gerund narration paragraphs as stop markers', () => {
    const text = extractAssistantTextFromRawLog(
      log('Reviewing the failing specs first.\n\nChecking the fixture setup now.\n\nFixed the off-by-one in foo.ts and added a regression test.')
    );

    expect(extractWorkSummary(text)).toEqual({
      summary: 'Fixed the off-by-one in foo.ts and added a regression test.',
      actionable: null,
    });
  });

  it('suppresses text delta events while compacting state is active', () => {
    const lines = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Before compact.' } } }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'HIDDEN compacted text.' } } }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'done' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'After compact.' } } }),
    ].join('\n');

    const result = extractAssistantTextFromRawLog(lines);
    expect(result).toContain('Before compact.');
    expect(result).not.toContain('HIDDEN compacted text.');
    expect(result).toContain('After compact.');
  });

  it('inserts a newline separator when a new text block starts after prior text has been emitted', () => {
    // Simulates two separate content_block_start+delta sequences (e.g. after a tool call),
    // which should be joined with a newline rather than run together.
    const lines = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'First block text.' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Second block text.' } } }),
    ].join('\n');

    const result = extractAssistantTextFromRawLog(lines);
    expect(result).toBe('First block text.\nSecond block text.');
  });

  it('reports actionable as false when the report field says "no"', () => {
    const text = extractAssistantTextFromRawLog(
      log('TamTam Run Report\nSummary: Nothing new to test.\nActionable work: no\n')
    );

    expect(extractWorkSummary(text)).toEqual({
      summary: 'Nothing new to test.',
      actionable: false,
    });
  });

  it('treats the improve agent IMPROVE_QUEUE_ROTATED sentinel as no actionable work', () => {
    const text = extractAssistantTextFromRawLog(log('IMPROVE_QUEUE_ROTATED 0'));

    // A clean-walk sentinel (no standard report) means the queue was empty —
    // idle, not broken. The summary is persisted so later health analysis can
    // recognize the run as idle without rereading the raw log.
    expect(extractWorkSummary(text)).toEqual({
      summary: 'IMPROVE_QUEUE_ROTATED: queue empty; no actionable work.',
      actionable: false,
    });
  });

  it('does not let the sentinel override an explicit "Actionable work: yes"', () => {
    const text = extractAssistantTextFromRawLog(
      log('TamTam Run Report\nSummary: Fixed a thing.\nActionable work: yes\nIMPROVE_QUEUE_ROTATED 3\n')
    );

    expect(extractWorkSummary(text).actionable).toBe(true);
  });

  it('returns null summary when there is no assistant text', () => {
    expect(extractWorkSummary('')).toEqual({ summary: null, actionable: null });
  });
});
