import { describe, expect, it } from 'vitest';
import { extractFailureLogDetailFromContent } from '@/lib/jobs/failure-log-detail';

describe('extractFailureLogDetailFromContent', () => {
  it('classifies stream_event-only logs as partial output instead of assistant text', () => {
    const content = `${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'foo' },
      },
    })}\n`;

    expect(extractFailureLogDetailFromContent(content)).toMatch(/partial/i);
  });

  it('keeps result text as the failure detail when a result event exists', () => {
    const content = `${JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'API Error: Stream idle timeout - partial response received',
    })}\n`;

    expect(extractFailureLogDetailFromContent(content)).toBe(
      'API Error: Stream idle timeout - partial response received',
    );
  });
});
