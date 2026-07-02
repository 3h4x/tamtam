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
  // Count fresh spend only: prompt input, generated output, and newly-cached
  // input. DELIBERATELY exclude `cache_read_input_tokens` — a cache READ is the
  // model re-reading context it already saw, billed at ~0.1× and NOT a sign of
  // a runaway. With prompt caching on (the norm), every agentic turn re-reads
  // the whole cached system prompt + skills + docs, so summing cache-reads
  // across turns balloons to millions even for a cheap run: a real 42-turn
  // issue-cruncher run measured 13.6k real (input+output) tokens but 2.8M
  // cache-reads — which falsely tripped the 2M cap and got reaped as a runaway.
  // A genuine runaway shows up in output / fresh input / cache-creation (and the
  // wall-clock cap backstops turn-count loops), so excluding cache-reads keeps
  // the guard honest without killing legitimate cached multi-turn work.
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Sum every `assistant` message's fresh token spend (input + output +
 * cache-creation; cache-reads excluded — see `usageTotal`) from a raw NDJSON
 * Claude-CLI log. The sum across turns is the run's cumulative fresh spend — the
 * number the runaway cap acts on.
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
