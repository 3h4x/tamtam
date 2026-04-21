// Default Claude API pricing (USD per 1M tokens). We don't track which model
// was used per job, so we apply a single rate card. Sonnet is the workhorse
// model for the pipeline — using Sonnet 4.x rates yields a useful estimate.
// Update here if pricing changes; tests rely on these constants.
export const PRICE_PER_MTOK = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
} as const;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export function costUsd(t: TokenCounts): number {
  return (
    (t.inputTokens * PRICE_PER_MTOK.input +
      t.outputTokens * PRICE_PER_MTOK.output +
      t.cacheCreateTokens * PRICE_PER_MTOK.cacheWrite +
      t.cacheReadTokens * PRICE_PER_MTOK.cacheRead) /
    1_000_000
  );
}

export function totalTokens(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreateTokens;
}
