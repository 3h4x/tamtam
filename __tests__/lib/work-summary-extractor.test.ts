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
  it('extracts assistant text from NDJSON logs with pm2 timestamps', () => {
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
});
