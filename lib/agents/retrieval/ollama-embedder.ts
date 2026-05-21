import { recordOllamaUsage } from './ollama-usage';

export interface EmbedContext {
  project?: string | null;
  sourceKind?: string | null;
}

// Hard cap on a single embed call. Ollama with a cold model can pause for
// 10–20s while loading; small models on a warm host return in <1s. 60s is
// generous for the slow path while preventing the retrieval pipeline from
// hanging forever if Ollama itself is wedged.
const EMBED_TIMEOUT_MS = 60_000;

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
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${response.statusText || ''}`.trim());
  }
  const data = await response.json() as {
    embeddings?: number[][];
    prompt_eval_count?: number;
    total_duration?: number;
  };

  // Defensive: Ollama can return `{ embeddings: [] }` if the model rejected
  // the input (e.g. empty/whitespace-only text, malformed UTF-8) or if a
  // future server version changes the response shape. Without this check
  // `data.embeddings[0]` is `undefined` and the function's `Promise<number[]>`
  // contract silently breaks — downstream callers feed `undefined` into
  // pgvector and the failure surfaces as a confusing array-type error.
  const vector = data.embeddings?.[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`Ollama embed returned no vector for model ${model}`);
  }

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

  return vector;
}
