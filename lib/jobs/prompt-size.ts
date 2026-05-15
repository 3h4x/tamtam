/**
 * Prompt-size telemetry: records the byte length of the prompt string passed
 * to `startJob` (i.e. whatever is piped to the Claude CLI's stdin) and warns
 * when it crosses a configurable threshold.
 *
 * Caveat — the measured value depends on the caller. Agent runs
 * (`/api/agents/[agentId]/run`) pass the fully composed prompt (system +
 * skills + task), so `prompt_bytes` reflects the cached prefix. Other callers
 * (`projects/.../run`, `.../fix-ci`, `jobs/.../rerun`) pass only the user
 * task, so their `prompt_bytes` undercounts the real cached prefix that
 * Claude bills against. When comparing across job kinds on /stats, treat the
 * per-kind average as the lower bound, not the true cache size. The exact
 * billed count comes from `cacheReadTokens` / `inputTokens` on the Claude
 * usage event after the run.
 *
 * Why bytes (not tokens): we don't want to pay for a tokenizer at every call
 * site. ~4 bytes/token is a stable approximation for English-heavy prompts.
 */

// 50 KB ≈ 12.5k tokens — about the floor where the cache-read cost of an
// always-injected prefix (CLAUDE.md + skills) starts to matter. Override with
// TAMTAM_PROMPT_WARN_BYTES.
const DEFAULT_WARN_BYTES = 50_000;
export const BYTES_PER_TOKEN = 4;

function warnThreshold(): number {
  const env = process.env.TAMTAM_PROMPT_WARN_BYTES;
  if (!env) return DEFAULT_WARN_BYTES;
  const n = parseInt(env, 10);
  return isNaN(n) || n <= 0 ? DEFAULT_WARN_BYTES : n;
}

export function measurePrompt(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

export function estimateTokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

export function checkPromptSize(jobId: string, kind: string, bytes: number): void {
  const threshold = warnThreshold();
  if (bytes > threshold) {
    console.warn(
      `[prompt-size] job=${jobId} kind=${kind} bytes=${bytes} (~${estimateTokens(bytes)} tokens) ` +
      `exceeds warn threshold ${threshold} — every cached read of this prefix will be billed`
    );
  }
}
