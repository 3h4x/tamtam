import { describe, it, expect } from 'vitest';
import { parseStreamLines, toolContentToString, createParseState } from '@/lib/jobs/claude-stream-parser';

describe('claude-stream-parser', () => {
  it('extracts text from content_block_delta', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('strips PM2 ISO timestamp prefix before parsing', () => {
    // PM2 with PM2_LOG_DATE_FORMAT set prepends `YYYY-MM-DDTHH:MM:SS: ` to every line.
    // The parser must strip it; otherwise getVerdict sees an empty log and the
    // release pipeline stalls at review.
    const line = '2026-04-22T12:51:05: {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"LGTM"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'text', text: 'LGTM' }]);
  });

  it('strips timestamp with fractional seconds and timezone', () => {
    const line = '2026-04-22T12:51:05.123Z: {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('strips timestamp with +HH:MM timezone offset', () => {
    const line = '2026-04-22T14:51:05+02:00: {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tz-offset"}}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'text', text: 'tz-offset' }]);
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
      result: { duration: 2393, sessionId: 'abc-123', error: false, inputTokens: 100, outputTokens: 500, cacheReadTokens: 1000, cacheCreateTokens: 200, model: 'claude-sonnet-4-6' },
    }]);
  });

  it('extracts model name from modelUsage key', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 500,
      session_id: 'sess-1', result: 'ok',
      modelUsage: { 'claude-opus-4-7': { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    });
    const events = parseStreamLines(line);
    expect(events).toHaveLength(1);
    if (events[0]?.type !== 'done') throw new Error('expected done');
    expect(events[0].result.model).toBe('claude-opus-4-7');
    expect(events[0].result.inputTokens).toBe(200);
    expect(events[0].result.outputTokens).toBe(100);
  });

  it('sums tokens across multiple models and picks primary by output tokens', () => {
    // Claude CLI reports a tiny haiku subagent alongside the real sonnet
    // workhorse. Taking the first key mislabels the run — pick the model
    // with the most output tokens instead.
    const line = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 1000,
      session_id: 'sess-2', result: 'ok',
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 50, outputTokens: 25, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 },
      },
    });
    const events = parseStreamLines(line);
    if (events[0]?.type !== 'done') throw new Error('expected done');
    expect(events[0].result.inputTokens).toBe(150);
    expect(events[0].result.outputTokens).toBe(225);
    expect(events[0].result.cacheReadTokens).toBe(300);
    expect(events[0].result.model).toBe('claude-sonnet-4-6');
  });

  it('extracts done with zero tokens when no modelUsage', () => {
    const line = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"abc","result":""}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{
      type: 'done',
      result: { duration: 100, sessionId: 'abc', error: true, errorKind: 'other', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, model: null },
    }]);
  });

  it('classifies error_during_execution as internal-cli and joins errors[] into errorText', () => {
    const line = '{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":49475,"session_id":"sess-x","terminal_reason":"aborted_streaming","errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]}';
    const events = parseStreamLines(line);
    if (events[0]?.type !== 'done') throw new Error('expected done');
    expect(events[0].result.error).toBe(true);
    expect(events[0].result.errorKind).toBe('internal-cli');
    expect(events[0].result.errorText).toContain('ede_diagnostic');
  });

  it('classifies aborted_streaming as internal-cli even without errors[]', () => {
    const line = '{"type":"result","subtype":"success","is_error":true,"duration_ms":100,"session_id":"s","terminal_reason":"aborted_streaming"}';
    const events = parseStreamLines(line);
    if (events[0]?.type !== 'done') throw new Error('expected done');
    expect(events[0].result.errorKind).toBe('internal-cli');
    expect(events[0].result.errorText).toContain('aborted_streaming');
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
    expect(events[0].result.model).toBeNull();
  });

  it('does not attach errorText when result is empty string even on error', () => {
    const line = '{"type":"result","subtype":"error","is_error":true,"duration_ms":50,"session_id":"s","result":""}';
    const events = parseStreamLines(line);
    if (events[0]?.type !== 'done') throw new Error('expected done');
    expect(events[0].result.errorText).toBeUndefined();
    expect(events[0].result.model).toBeNull();
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

  it('extracts assistant message text when no stream deltas are present', () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}';
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('extracts every text block from a snapshot-only assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First block' },
          { type: 'text', text: 'Second block' },
        ],
      },
    });
    const events = parseStreamLines(line);
    expect(events).toEqual([
      { type: 'text', text: 'First block' },
      { type: 'text', text: 'Second block' },
    ]);
  });

  it('does not duplicate assistant snapshots after stream text deltas', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('preserves later snapshot text blocks after streamed text already covered the first block', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First block"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First block"},{"type":"text","text":"Second block"}]}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([
      { type: 'text', text: 'First block' },
      { type: 'text', text: 'Second block' },
    ]);
  });

  it('does not duplicate assistant tool snapshots after streamed tool_use events', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Read"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"README.md\\"}"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}}]}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([{ type: 'tool_use', name: 'Read', input: '{"file_path":"README.md"}' }]);
  });

  it('extracts every tool_use block from a snapshot-only assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } },
          { type: 'tool_use', name: 'Glob', input: { pattern: '*.md' } },
        ],
      },
    });
    const events = parseStreamLines(line);
    expect(events).toEqual([
      { type: 'tool_use', name: 'Read', input: '{"file_path":"README.md"}' },
      { type: 'tool_use', name: 'Glob', input: '{"pattern":"*.md"}' },
    ]);
  });

  it('preserves later snapshot tool_use blocks after a streamed tool_use already emitted', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Read"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"README.md\\"}"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}},{"type":"tool_use","name":"Glob","input":{"pattern":"*.md"}}]}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([
      { type: 'tool_use', name: 'Read', input: '{"file_path":"README.md"}' },
      { type: 'tool_use', name: 'Glob', input: '{"pattern":"*.md"}' },
    ]);
  });

  it('does not let streamed text from one assistant turn suppress a later snapshot-only assistant turn', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First turn"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First turn"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"ok"}]}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Second turn"}]}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([
      { type: 'text', text: 'First turn' },
      { type: 'tool_result', content: 'ok' },
      { type: 'text', text: 'Second turn' },
    ]);
  });

  it('does not let streamed tool_use from one assistant turn suppress a later snapshot-only tool_use turn', () => {
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Read"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"README.md\\"}"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"contents"}]}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Glob","input":{"pattern":"*.md"}}]}}',
    ].join('\n');
    const events = parseStreamLines(lines);
    expect(events).toEqual([
      { type: 'tool_use', name: 'Read', input: '{"file_path":"README.md"}' },
      { type: 'tool_result', content: 'contents' },
      { type: 'tool_use', name: 'Glob', input: '{"pattern":"*.md"}' },
    ]);
  });

  it('extracts tool_use from assistant message snapshots', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }],
      },
    });
    const events = parseStreamLines(line);
    expect(events).toEqual([{ type: 'tool_use', name: 'Read', input: '{"file_path":"README.md"}' }]);
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

    it('uses output field as fallback when content is absent in system tool_result', () => {
      const line = JSON.stringify({
        type: 'system', subtype: 'tool_result', output: 'output-only value',
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'tool_result', content: 'output-only value' }]);
    });

    it('emits nothing when both content and output are absent in system tool_result', () => {
      const line = JSON.stringify({ type: 'system', subtype: 'tool_result' });
      const events = parseStreamLines(line);
      expect(events).toEqual([]);
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

  // Regression: after the type-narrowing refactor, undefined delta fields must
  // fall back to '' rather than emitting undefined as the text value.
  describe('?? fallbacks for missing delta fields', () => {
    it('emits empty string when thinking_delta is missing thinking field', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } },
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'thinking', text: '' }]);
    });

    it('emits empty string when text_delta is missing text field', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } },
      });
      const events = parseStreamLines(line);
      expect(events).toEqual([{ type: 'text', text: '' }]);
    });

    it('emits tool_use with empty name when content_block has no name', () => {
      const lines = [
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
      ].join('\n');
      const events = parseStreamLines(lines);
      expect(events).toEqual([{ type: 'tool_use', name: '', input: '' }]);
    });

    it('treats missing partial_json in input_json_delta as empty string', () => {
      const lines = [
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
      ].join('\n');
      const events = parseStreamLines(lines);
      expect(events).toEqual([{ type: 'tool_use', name: 'Bash', input: '{"cmd":"ls"}' }]);
    });

    it('strips PM2 timestamp leaving only whitespace — skips the line', () => {
      // A line that IS a valid timestamp prefix but has nothing after it should
      // not throw or produce events.
      const line = '2026-04-22T12:51:05: ';
      const events = parseStreamLines(line);
      expect(events).toEqual([]);
    });
  });

  describe('toolContentToString', () => {
    it('returns empty string for null/undefined', () => {
      expect(toolContentToString(null)).toBe('');
      expect(toolContentToString(undefined)).toBe('');
    });

    it('converts numbers to string', () => {
      expect(toolContentToString(42)).toBe('42');
    });

    it('converts boolean to string', () => {
      expect(toolContentToString(false)).toBe('false');
    });

    it('returns string unchanged', () => {
      expect(toolContentToString('hello')).toBe('hello');
    });

    it('joins string elements in array', () => {
      expect(toolContentToString(['foo', 'bar'])).toBe('foo\nbar');
    });

    it('JSON stringifies unknown block types in arrays', () => {
      const result = toolContentToString([{ type: 'video', url: 'x' }]);
      expect(result).toBe('{"type":"video","url":"x"}');
    });
  });

  describe('createParseState', () => {
    it('returns zeroed state', () => {
      const state = createParseState();
      expect(state).toEqual({
        currentToolName: '',
        currentToolInput: '',
        inToolUse: false,
        inTextBlock: false,
        countedCurrentTextBlock: false,
        hasEmitted: false,
        isCompacting: false,
        lastTextTail: '',
        streamedTextBlockCount: 0,
        streamedToolUseCount: 0,
      });
    });

    it('shared state accumulates tool input across multiple parseStreamLines calls', () => {
      const state = createParseState();
      const opts = { state };
      parseStreamLines(
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read' } } }),
        opts,
      );
      parseStreamLines(
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } } }),
        opts,
      );
      parseStreamLines(
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"x.ts"}' } } }),
        opts,
      );
      const events = parseStreamLines(
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
        opts,
      );
      expect(events).toEqual([{ type: 'tool_use', name: 'Read', input: '{"path":"x.ts"}' }]);
    });
  });

  describe('paragraph boundary between consecutive text deltas', () => {
    function delta(text: string): string {
      return JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      });
    }

    it('inserts \\n\\n between two paragraph-sized deltas with no separator', () => {
      const state = createParseState();
      const opts = { state };
      const out: string[] = [];
      for (const e of parseStreamLines(delta('First sentence ends here.'), opts)) if (e.type === 'text') out.push(e.text);
      for (const e of parseStreamLines(delta('Second paragraph begins now.'), opts)) if (e.type === 'text') out.push(e.text);
      expect(out.join('')).toBe('First sentence ends here.\n\nSecond paragraph begins now.');
    });

    it('does NOT insert a break for token-streaming fragments mid-word', () => {
      const state = createParseState();
      const opts = { state };
      const out: string[] = [];
      for (const e of parseStreamLines(delta('I'), opts)) if (e.type === 'text') out.push(e.text);
      for (const e of parseStreamLines(delta("'ve"), opts)) if (e.type === 'text') out.push(e.text);
      for (const e of parseStreamLines(delta(' got it.'), opts)) if (e.type === 'text') out.push(e.text);
      expect(out.join('')).toBe("I've got it.");
    });

    it('does NOT insert a break when previous delta already ends in whitespace', () => {
      const state = createParseState();
      const opts = { state };
      const out: string[] = [];
      for (const e of parseStreamLines(delta('Done. '), opts)) if (e.type === 'text') out.push(e.text);
      for (const e of parseStreamLines(delta('Next bit.'), opts)) if (e.type === 'text') out.push(e.text);
      expect(out.join('')).toBe('Done. Next bit.');
    });

    it('does NOT insert a break when next delta starts mid-sentence (lowercase)', () => {
      const state = createParseState();
      const opts = { state };
      const out: string[] = [];
      for (const e of parseStreamLines(delta('Status:'), opts)) if (e.type === 'text') out.push(e.text);
      for (const e of parseStreamLines(delta('fixed'), opts)) if (e.type === 'text') out.push(e.text);
      expect(out.join('')).toBe('Status:fixed');
    });
  });
});
