// Live per-run token accounting for the runaway-run guard.
//
// The stream parser (`claude-stream-parser.ts`) only surfaces a token total in
// the final `result` event — useless for killing a run that is *still* burning
// tokens. Claude CLI, however, stamps `message.usage` on every `assistant`
// message as the turn completes. Summing those turn usages gives a monotonic
// running total we can compare against `run_token_cap` mid-flight.
//
// Pure + string-in so it is trivially unit-testable and callable from the probe
// sweep against a job's on-disk log without touching the DB.

const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:\s/;

type UsageBlock = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function usageTotal(usage: UsageBlock | undefined): number {
  if (!usage || typeof usage !== 'object') return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Sum every `assistant` message's `message.usage` (input + output + cache) from
 * a raw NDJSON Claude-CLI log. Each turn is billed independently, so the sum
 * across turns is the run's cumulative token spend — the number the cap acts on.
 *
 * Tolerates PM2 ISO timestamp prefixes and non-JSON lines (skipped). Returns 0
 * for an empty/garbage log rather than throwing, so a caller can treat "no
 * parseable usage yet" as "under cap".
 */
export function accumulateRunTokens(rawLog: string): number {
  if (!rawLog) return 0;
  let total = 0;
  for (const line of rawLog.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(TS_PREFIX_RE);
    if (m) trimmed = trimmed.slice(m[0].length);
    if (!trimmed.startsWith('{')) continue;
    let parsed: { type?: string; message?: { usage?: UsageBlock } };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.type === 'assistant' && parsed.message?.usage) {
      total += usageTotal(parsed.message.usage);
    }
  }
  return total;
}
