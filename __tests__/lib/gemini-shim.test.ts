import { createRequire } from 'module';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const _require = createRequire(import.meta.url);
const shim = _require(join(process.cwd(), 'scripts/gemini-shim.js')) as {
  resolveGeminiModel: (model: string, env?: NodeJS.ProcessEnv) => string;
  APPROVAL_MAP: Record<string, string>;
  parseShimArgs: (argv: string[], env?: NodeJS.ProcessEnv) => { model: string; approvalMode: string; cwd: string; geminiArgs: string[] };
  createGeminiTranslator: (modelName: string) => { translateLine: (line: string) => string[]; flush: () => string[] };
};

describe('gemini-shim model resolution', () => {
  it('translates fast → flash (default)', () => {
    expect(shim.resolveGeminiModel('fast', {})).toBe('flash');
  });

  it('translates normal → pro (default)', () => {
    expect(shim.resolveGeminiModel('normal', {})).toBe('pro');
  });

  it('translates smart → pro (default)', () => {
    expect(shim.resolveGeminiModel('smart', {})).toBe('pro');
  });

  it('translates thinking → thinking', () => {
    expect(shim.resolveGeminiModel('thinking', {})).toBe('thinking');
  });

  it('respects GEMINI_FAST_MODEL env override', () => {
    expect(shim.resolveGeminiModel('fast', { GEMINI_FAST_MODEL: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash');
  });

  it('respects GEMINI_HAIKU_MODEL legacy alias for fast tier', () => {
    expect(shim.resolveGeminiModel('haiku', { GEMINI_HAIKU_MODEL: 'gemini-test-haiku' })).toBe('gemini-test-haiku');
  });

  it('falls back to GEMINI_MODEL for unknown tier names', () => {
    expect(shim.resolveGeminiModel('someunknown', { GEMINI_MODEL: 'gemini-custom' })).toBe('gemini-custom');
  });

  it('passes an already-resolved model ID through unchanged', () => {
    expect(shim.resolveGeminiModel('gemini-1.5-pro-002', {})).toBe('gemini-1.5-pro-002');
  });

  it('handles --model=<value> equals-form', () => {
    const { geminiArgs } = shim.parseShimArgs(['--model=fast'], {});
    const idx = geminiArgs.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(geminiArgs[idx + 1]).toBe('flash');
  });
});

describe('gemini-shim approval mode mapping', () => {
  it('maps bypassPermissions → yolo', () => {
    const { geminiArgs } = shim.parseShimArgs(['--permission-mode', 'bypassPermissions'], {});
    const idx = geminiArgs.indexOf('--approval-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(geminiArgs[idx + 1]).toBe('yolo');
  });

  it('maps auto → auto_edit', () => {
    const { geminiArgs } = shim.parseShimArgs(['--permission-mode', 'auto'], {});
    expect(geminiArgs[geminiArgs.indexOf('--approval-mode') + 1]).toBe('auto_edit');
  });

  it('maps plan → plan', () => {
    const { geminiArgs } = shim.parseShimArgs(['--permission-mode', 'plan'], {});
    expect(geminiArgs[geminiArgs.indexOf('--approval-mode') + 1]).toBe('plan');
  });

  it('maps default → default', () => {
    const { geminiArgs } = shim.parseShimArgs(['--permission-mode=default'], {});
    expect(geminiArgs[geminiArgs.indexOf('--approval-mode') + 1]).toBe('default');
  });

  it('consumes --output-format and does not forward it to gemini', () => {
    const { geminiArgs } = shim.parseShimArgs(['--output-format', 'stream-json', '--model', 'fast'], {});
    const formatIndices = geminiArgs.reduce<number[]>((acc, a, i) => (a === '--output-format' ? [...acc, i] : acc), []);
    expect(formatIndices).toHaveLength(1);
    expect(geminiArgs[formatIndices[0] + 1]).toBe('stream-json');
  });
});

describe('gemini-shim stream translation', () => {
  function runTranslator(events: object[], modelName = 'flash'): object[] {
    const translator = shim.createGeminiTranslator(modelName);
    const lines: object[] = [];
    for (const event of events) {
      for (const out of translator.translateLine(JSON.stringify(event))) {
        lines.push(JSON.parse(out));
      }
    }
    for (const out of translator.flush()) {
      lines.push(JSON.parse(out));
    }
    return lines;
  }

  it('translates assistant message to text_delta events', () => {
    const lines = runTranslator([
      { type: 'message', role: 'assistant', content: 'Hello world' },
      { type: 'result', status: 'success', model: 'gemini-1.5-pro', stats: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const text = lines
      .filter((l: any) => l.type === 'stream_event' && l.event?.type === 'content_block_delta')
      .map((l: any) => l.event.delta.text)
      .join('');
    expect(text).toBe('Hello world');
    expect(lines.some((l: any) => l.type === 'stream_event' && l.event?.type === 'content_block_start')).toBe(true);
  });

  it('translates result event to Claude result format with modelUsage', () => {
    const lines = runTranslator([
      { type: 'message', role: 'assistant', content: 'Done' },
      { type: 'result', status: 'success', model: 'gemini-1.5-pro', stats: { input_tokens: 20, output_tokens: 8 } },
    ]);
    const result: any = lines.find((l: any) => l.type === 'result');
    expect(result).toBeDefined();
    expect(result.is_error).toBe(false);
    const usage = result.modelUsage['gemini-1.5-pro'];
    expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 8 });
  });

  it('emits content_block_stop after text block before tool_use', () => {
    const lines = runTranslator([
      { type: 'message', role: 'assistant', content: 'Thinking...' },
      { type: 'tool_use', tool_name: 'bash', tool_id: 'tool-1', parameters: { cmd: 'ls' } },
      { type: 'result', status: 'success', model: 'gemini-1.5-pro', stats: {} },
    ]);
    const stopBeforeTool = lines.findIndex(
      (l: any) => l.type === 'stream_event' && l.event?.type === 'content_block_stop',
    );
    const toolStart = lines.findIndex(
      (l: any) => l.type === 'stream_event' && l.event?.type === 'content_block_start' && l.event.content_block?.type === 'tool_use',
    );
    expect(stopBeforeTool).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeGreaterThan(stopBeforeTool);
  });

  it('emits error result when underlying gemini result has status error', () => {
    const lines = runTranslator([
      { type: 'result', status: 'error', error: 'quota exceeded', model: 'gemini-1.5-pro', stats: {} },
    ]);
    const result: any = lines.find((l: any) => l.type === 'result');
    expect(result?.is_error).toBe(true);
    expect(result?.result).toContain('quota exceeded');
  });
});
