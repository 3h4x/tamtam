import { describe, it, expect } from 'vitest';
import { parseStreamLines } from '@/lib/claude-stream-parser';

describe('claude-stream-parser', () => {
  it('extracts text from content_block_delta', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'text', text: 'Hello' }]);
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

  it('ignores thinking deltas', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([]);
  });

  it('ignores assistant message events', () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([]);
  });
});
