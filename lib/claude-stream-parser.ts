export type ParsedEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: string }
  | { type: 'tool_result'; content: string }
  | { type: 'done'; result: { duration: number; sessionId: string; error: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number } };

export function parseStreamLines(content: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let currentToolName = '';
  let currentToolInput = '';
  let inToolUse = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed.type === 'stream_event') {
      const evt = parsed.event;

      // Thinking deltas
      if (
        evt?.type === 'content_block_delta' &&
        evt?.delta?.type === 'thinking_delta'
      ) {
        events.push({ type: 'thinking', text: evt.delta.thinking });
      }

      // Text deltas from assistant
      if (
        evt?.type === 'content_block_delta' &&
        evt?.delta?.type === 'text_delta'
      ) {
        events.push({ type: 'text', text: evt.delta.text });
      }

      // Tool use start — capture tool name
      if (
        evt?.type === 'content_block_start' &&
        evt?.content_block?.type === 'tool_use'
      ) {
        inToolUse = true;
        currentToolName = evt.content_block.name ?? '';
        currentToolInput = '';
      }

      // Tool input JSON delta
      if (
        evt?.type === 'content_block_delta' &&
        evt?.delta?.type === 'input_json_delta'
      ) {
        currentToolInput += evt.delta.partial_json ?? '';
      }

      // Content block stop — emit tool_use if we were in one
      if (evt?.type === 'content_block_stop' && inToolUse) {
        events.push({ type: 'tool_use', name: currentToolName, input: currentToolInput });
        inToolUse = false;
        currentToolName = '';
        currentToolInput = '';
      }

      // New text block — add separator between content blocks
      if (
        evt?.type === 'content_block_start' &&
        evt?.content_block?.type === 'text' &&
        events.length > 0
      ) {
        events.push({ type: 'text', text: '\n' });
      }
    }

    // Tool results from system events
    if (
      parsed.type === 'system' &&
      parsed.subtype === 'tool_result'
    ) {
      const content = parsed.content ?? parsed.output ?? '';
      if (content) {
        events.push({ type: 'tool_result', content: typeof content === 'string' ? content : JSON.stringify(content) });
      }
    }

    // Final result — extract token usage from modelUsage
    if (parsed.type === 'result') {
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0;
      if (parsed.modelUsage) {
        for (const model of Object.values(parsed.modelUsage) as any[]) {
          inputTokens += model.inputTokens ?? 0;
          outputTokens += model.outputTokens ?? 0;
          cacheReadTokens += model.cacheReadInputTokens ?? 0;
          cacheCreateTokens += model.cacheCreationInputTokens ?? 0;
        }
      }
      events.push({
        type: 'done',
        result: {
          duration: parsed.duration_ms ?? 0,
          sessionId: parsed.session_id ?? '',
          error: parsed.is_error ?? false,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreateTokens,
        },
      });
    }
  }
  return events;
}
