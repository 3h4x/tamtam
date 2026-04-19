import { describe, it, expect } from 'vitest';
import { parseStreamLines } from '@/lib/claude-stream-parser';

describe('claude-stream-parser', () => {
  it('extracts text from content_block_delta', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('extracts thinking from thinking_delta', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about this"}},"session_id":"abc"}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'thinking', text: 'Let me think about this' }]);
  });

  it('separates thinking and text events', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: 'Hello' },
    ]);
  });

  it('extracts done from result event with token usage', () => {
    const line = '{"type":"result","subtype":"success","is_error":false,"duration_ms":2393,"total_cost_usd":0.156,"session_id":"abc-123","result":"Hello world","modelUsage":{"claude-sonnet-4-6":{"inputTokens":100,"outputTokens":500,"cacheReadInputTokens":1000,"cacheCreationInputTokens":200}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{
      type: 'done',
      result: { duration: 2393, sessionId: 'abc-123', error: false, inputTokens: 100, outputTokens: 500, cacheReadTokens: 1000, cacheCreateTokens: 200 },
    }]);
  });

  it('extracts done with zero tokens when no modelUsage', () => {
    const line = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"abc","result":""}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{
      type: 'done',
      result: { duration: 100, sessionId: 'abc', error: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    }]);
  });

  it('attaches errorText when is_error=true and result is a non-empty string', () => {
    const line = '{"type":"result","subtype":"success","is_error":true,"duration_ms":9636496,"total_cost_usd":1.5,"session_id":"sess-x","result":"API Error: Stream idle timeout - partial response received"}';
    const events = parseStreamLines(line);
    expect(events).toHaveLength(1);
    const done = events[0];
    expect(done.type).toBe('done');
    if (done.type !== 'done') return;
    expect(done.result.error).toBe(true);
    expect(done.result.errorText).toBe('API Error: Stream idle timeout - partial response received');
  });

  it('does not attach errorText on successful runs', () => {
    const line = '{"type":"result","subtype":"success","is_error":false,"duration_ms":100,"session_id":"s","result":"done"}';
    const events = parseStreamLines(line);
    if (events[0]?.type !== 'done') throw new Error('expected done');
    expect(events[0].result.errorText).toBeUndefined();
  });

  it('does not attach errorText when result is empty string even on error', () => {
    const line = '{"type":"result","subtype":"error","is_error":true,"duration_ms":50,"session_id":"s","result":""}';
    const events = parseStreamLines(line);
    if (events[0]?.type !== 'done') throw new Error('expected done');
    expect(events[0].result.errorText).toBeUndefined();
  });

  it('ignores system/init/hook events', () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"x"}',
      '{"type":"system","subtype":"hook_started","hook_id":"h1"}',
      '{"type":"system","subtype":"hook_response","hook_id":"h1"}',
      '{"type":"system","subtype":"status","status":"requesting"}',
      '{"type":"rate_limit_event","rate_limit_info":{}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([]);
  });

  it('handles empty lines gracefully', () => {
    const events = parseStreamLines('\n\n\n');
    expect(events).toEqual([]);
  });

  it('handles malformed/non-JSON lines without throwing', () => {
    const events = parseStreamLines('not json at all\n{broken');
    expect(events).toEqual([]);
  });

  it('parses multiple text deltas in one call', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([
      { type: 'text', text: 'Hey' },
      { type: 'text', text: ' there' },
    ]);
  });

  it('extracts tool_use from content_block_start + input_json_delta + stop', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"Read"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file\\":\\"x.ts\\"}"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([
      { type: 'tool_use', name: 'Read', input: '{"file":"x.ts"}' },
    ]);
  });

  it('extracts tool_result from system events', () => {
    const line = '{"type":"system","subtype":"tool_result","content":"file contents here"}';
    const events = parseStreamLines(line);
    expect(events).toEqual([
      { type: 'tool_result', content: 'file contents here' },
    ]);
  });

  it('adds separator between text content blocks', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Second"}}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    const texts = events.filter(e => e.type === 'text').map(e => (e as any).text);
    expect(texts).toEqual(['First', '\n', 'Second']);
  });

  it('parses thinking deltas', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'thinking', text: 'hmm' }]);
  });

  it('ignores assistant message events', () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([]);
  });

  // Regression: the parser used to JSON.stringify any non-string tool_result
  // content, which made structured tool outputs appear in the terminal as raw
  // `[{"type":"text","text":"..."}]` JSON blobs — exactly what the user sees
  // in the release meta-terminal review section.
  describe('tool_result content extraction', () => {
    it('extracts text from array-of-blocks content (system tool_result)', () => {
      const line = JSON.stringify({
        type: 'system', subtype: 'tool_result',
        content: [{ type: 'text', text: 'file written' }],
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'tool_result', content: 'file written' }]);
    });

    it('joins multiple text blocks with newlines', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            content: [
              { type: 'text', text: 'line 1' },
              { type: 'text', text: 'line 2' },
            ],
          }],
        },
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'tool_result', content: 'line 1\nline 2' }]);
    });

    it('renders image blocks as [image] placeholder', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            content: [
              { type: 'text', text: 'screenshot attached:' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxxx' } },
            ],
          }],
        },
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'tool_result', content: 'screenshot attached:\n[image]' }]);
    });

    it('passes through plain string content unchanged', () => {
      const line = JSON.stringify({
        type: 'system', subtype: 'tool_result', content: 'plain string output',
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'tool_result', content: 'plain string output' }]);
    });

    it('extracts text property from object-shaped content', () => {
      const line = JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: { text: 'single object text' } }] },
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'tool_result', content: 'single object text' }]);
    });

    it('falls back to JSON stringification for truly unknown shapes', () => {
      const line = JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: { foo: 'bar', baz: 42 } }] },
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'tool_result', content: '{"foo":"bar","baz":42}' }]);
    });

    it('does not emit raw Claude usage/metadata objects as text', () => {
      // This is the shape the user saw dumped as raw JSON in the terminal.
      // parseStreamLines should ignore usage-only message_delta events.
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 20,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1936 },
            service_tier: 'standard',
          },
        },
        parent_tool_use_id: null,
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([]);
    });
  });
});
