import { recordOllamaUsage } from './ollama-usage';

export interface EmbedContext {
  project?: string | null;
  sourceKind?: string | null;
}

export async function embedText(
  text: string,
  ollamaUrl: string,
  model: string,
  context: EmbedContext = {},
): Promise<number[]> {
  const startedAt = Date.now();
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status}`);
  }
  const data = await response.json() as {
    embeddings: number[][];
    prompt_eval_count?: number;
    total_duration?: number;
  };

  // Prefer Ollama's own counters; fall back to wall-clock and a crude
  // 4-chars-per-token estimate if the server doesn't include them.
  const inputTokens = typeof data.prompt_eval_count === 'number'
    ? data.prompt_eval_count
    : Math.ceil(text.length / 4);
  const durationMs = typeof data.total_duration === 'number'
    ? data.total_duration / 1_000_000
    : Date.now() - startedAt;

  recordOllamaUsage({
    model,
    project: context.project ?? null,
    sourceKind: context.sourceKind ?? null,
    inputTokens,
    durationMs,
  });

  return data.embeddings[0];
}
