import { db, schema } from '@/lib/db';

export interface OllamaUsageRow {
  model: string;
  project?: string | null;
  sourceKind?: string | null;
  inputTokens: number;
  durationMs: number;
}

// Fire-and-forget recorder. Embedding callers should never fail because the
// telemetry write failed, so all errors are swallowed.
export function recordOllamaUsage(row: OllamaUsageRow): void {
  db.insert(schema.ollamaUsage).values({
    ts: Date.now() / 1000,
    model: row.model,
    project: row.project ?? null,
    sourceKind: row.sourceKind ?? null,
    inputTokens: Math.max(0, Math.round(row.inputTokens)),
    durationMs: Math.max(0, Math.round(row.durationMs)),
  }).execute().catch((err) => {
    console.warn('[ollama-usage] failed to record:', err);
  });
}
