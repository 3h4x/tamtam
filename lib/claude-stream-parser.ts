type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type StreamEventField = {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  content_block?: { type?: string; name?: string };
};

type ParsedLine = {
  type?: string;
  event?: StreamEventField;
  subtype?: string;
  content?: unknown;
  output?: unknown;
  message?: { content?: Array<{ type?: string; content?: unknown }> };
  modelUsage?: Record<string, ModelUsage>;
  is_error?: boolean;
  result?: unknown;
  duration_ms?: number;
  session_id?: string;
};

export type ParsedEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: string }
  | { type: 'tool_result'; content: string }
  | { type: 'done'; result: { duration: number; sessionId: string; error: boolean; errorText?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; model: string | null } };

// Tool results arrive as either a string or an array of content blocks
// ([{type:"text",text:"..."}, {type:"image",...}]). Dumping the array with
// JSON.stringify would pollute the terminal with raw JSON — extract the
// text payload so the user sees readable output.
export function toolContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block?.type === 'image') parts.push('[image]');
      else parts.push(JSON.stringify(block));
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    return JSON.stringify(content);
  }
  return String(content ?? '');
}

// Mutable state that can be shared across parseStreamLines calls so that
// tool_use blocks spanning multiple chunks (start on one read, stop on the
// next) still emit, and the inter-text-block newline guard works correctly
// when input is fed one line at a time.
export interface ParseState {
  currentToolName: string;
  currentToolInput: string;
  inToolUse: boolean;
  hasEmitted: boolean;
}

export function createParseState(): ParseState {
  return { currentToolName: '', currentToolInput: '', inToolUse: false, hasEmitted: false };
}

export interface ParseOptions {
  state?: ParseState;
  // Called for each non-empty line that is not parseable as JSON. Receives the
  // line with any PM2 timestamp prefix stripped (or the original line if no
  // prefix was present). Used by passthrough-mode callers to surface plain
  // shell output interleaved with NDJSON.
  onRawLine?: (line: string) => void;
}

export function parseStreamLines(content: string, options: ParseOptions = {}): ParsedEvent[] {
  const state = options.state ?? createParseState();
  const events: ParsedEvent[] = [];
  const push = (e: ParsedEvent) => { events.push(e); state.hasEmitted = true; };

  // PM2 can be configured to prepend an ISO timestamp to every line
  // (PM2_LOG_DATE_FORMAT / pm2 set). Strip it so JSON.parse sees a valid object.
  // Example prefix: `2026-04-22T12:51:05: {...}` (note the `: ` separator).
  const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:\s/;

  for (const line of content.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(TS_PREFIX_RE);
    if (m) trimmed = trimmed.slice(m[0].length);
    if (!trimmed) continue;

    let parsed: ParsedLine;
    try {
      parsed = JSON.parse(trimmed) as ParsedLine;
    } catch {
      options.onRawLine?.(m ? trimmed : line);
      continue;
    }

    if (parsed.type === 'stream_event') {
      const evt = parsed.event;

      // Thinking deltas
      if (
        evt?.type === 'content_block_delta' &&
        evt?.delta?.type === 'thinking_delta'
      ) {
        push({ type: 'thinking', text: evt.delta.thinking ?? '' });
      }

      // Text deltas from assistant
      if (
        evt?.type === 'content_block_delta' &&
        evt?.delta?.type === 'text_delta'
      ) {
        push({ type: 'text', text: evt.delta.text ?? '' });
      }

      // Tool use start — capture tool name
      if (
        evt?.type === 'content_block_start' &&
        evt?.content_block?.type === 'tool_use'
      ) {
        state.inToolUse = true;
        state.currentToolName = evt.content_block.name ?? '';
        state.currentToolInput = '';
      }

      // Tool input JSON delta
      if (
        evt?.type === 'content_block_delta' &&
        evt?.delta?.type === 'input_json_delta'
      ) {
        state.currentToolInput += evt.delta.partial_json ?? '';
      }

      // Content block stop — emit tool_use if we were in one
      if (evt?.type === 'content_block_stop' && state.inToolUse) {
        push({ type: 'tool_use', name: state.currentToolName, input: state.currentToolInput });
        state.inToolUse = false;
        state.currentToolName = '';
        state.currentToolInput = '';
      }

      // New text block — add separator between content blocks. Uses
      // state.hasEmitted (not events.length) so the guard still works when
      // input is fed one line at a time via shared state.
      if (
        evt?.type === 'content_block_start' &&
        evt?.content_block?.type === 'text' &&
        state.hasEmitted
      ) {
        push({ type: 'text', text: '\n' });
      }
    }

    // Tool results from system events
    if (
      parsed.type === 'system' &&
      parsed.subtype === 'tool_result'
    ) {
      const content = parsed.content ?? parsed.output ?? '';
      if (content) {
        push({ type: 'tool_result', content: toolContentToString(content) });
      }
    }

    // Tool results from user message events (Write, Edit, Bash, etc.)
    if (parsed.type === 'user' && parsed.message?.content) {
      for (const block of Array.isArray(parsed.message.content) ? parsed.message.content : []) {
        if (block.type === 'tool_result' && block.content) {
          push({ type: 'tool_result', content: toolContentToString(block.content) });
        }
      }
    }

    // Final result — extract token usage from modelUsage
    if (parsed.type === 'result') {
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0;
      let model: string | null = null;
      if (parsed.modelUsage) {
        const modelKeys = Object.keys(parsed.modelUsage);
        model = modelKeys.length > 0 ? modelKeys[0] : null;
        for (const usage of Object.values(parsed.modelUsage) as ModelUsage[]) {
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
          cacheReadTokens += usage.cacheReadInputTokens ?? 0;
          cacheCreateTokens += usage.cacheCreationInputTokens ?? 0;
        }
      }
      const errorText = parsed.is_error && typeof parsed.result === 'string' ? parsed.result : undefined;
      push({
        type: 'done',
        result: {
          duration: parsed.duration_ms ?? 0,
          sessionId: parsed.session_id ?? '',
          error: parsed.is_error ?? false,
          ...(errorText ? { errorText } : {}),
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreateTokens,
          model,
        },
      });
    }
  }
  return events;
}
