/**
 * Prompt-size telemetry and pre-spawn guardrails for the prompt string passed
 * to `startJob` (i.e. whatever is piped to the provider CLI's stdin).
 *
 * The start routes and pipeline builders pass the prompt they are about to
 * send to the provider CLI, after local skill/doc/base-prompt composition.
 * The exact billed count still comes from `cacheReadTokens` / `inputTokens`
 * on the provider usage event after the run.
 *
 * Why bytes (not tokens): we don't want to pay for a tokenizer at every call
 * site. ~4 bytes/token is a stable approximation for English-heavy prompts.
 */

import { getSettings } from '@/lib/shared/config';
import { costUsd } from '@/lib/shared/usage-pricing';

// 50 KB ~= 12.5k tokens — about the floor where the cache-read cost of an
// always-injected prefix (CLAUDE.md + skills) starts to matter. Override with
// TAMTAM_PROMPT_WARN_BYTES.
const DEFAULT_WARN_BYTES = 50_000;
export const BYTES_PER_TOKEN = 4;

export interface PromptEstimate {
  bytes: number;
  estimatedInputTokens: number;
  warnTokens: number;
  blockTokens: number;
  warning: boolean;
  blocked: boolean;
  modelTier: string | null;
  estimatedCostUsd: number;
}

export class PromptEstimateBlockedError extends Error {
  readonly estimate: PromptEstimate;

  constructor(estimate: PromptEstimate) {
    super(
      `Prompt estimate ${estimate.estimatedInputTokens.toLocaleString()} tokens exceeds block threshold ` +
      `${estimate.blockTokens.toLocaleString()} tokens. Reduce attached docs, skills, or diff/context payload before starting this run.`,
    );
    this.name = 'PromptEstimateBlockedError';
    this.estimate = estimate;
  }
}

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

export function estimatePromptCost(
  prompt: string,
  options: { modelTier?: string | null; warnTokens?: number; blockTokens?: number } = {},
): PromptEstimate {
  const settings = getSettings();
  const bytes = measurePrompt(prompt);
  const estimatedInputTokens = estimateTokens(bytes);
  const warnTokens = Math.max(0, options.warnTokens ?? settings.prompt_estimate_warn_tokens);
  const blockTokens = Math.max(0, options.blockTokens ?? settings.prompt_estimate_block_tokens);
  const warning = warnTokens > 0 && estimatedInputTokens >= warnTokens;
  const blocked = blockTokens > 0 && estimatedInputTokens > blockTokens;
  return {
    bytes,
    estimatedInputTokens,
    warnTokens,
    blockTokens,
    warning,
    blocked,
    modelTier: options.modelTier ?? null,
    estimatedCostUsd: costUsd({
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }),
  };
}

export function assertPromptEstimateAllowed(
  prompt: string,
  options: { modelTier?: string | null; warnTokens?: number; blockTokens?: number } = {},
): PromptEstimate {
  const estimate = estimatePromptCost(prompt, options);
  if (estimate.blocked) {
    throw new PromptEstimateBlockedError(estimate);
  }
  return estimate;
}

export function promptEstimateResponseDetail(estimate: PromptEstimate): string {
  return (
    `Prompt estimate is ${estimate.estimatedInputTokens.toLocaleString()} input tokens ` +
    `(${estimate.bytes.toLocaleString()} bytes), above the configured block threshold of ` +
    `${estimate.blockTokens.toLocaleString()} tokens. Reduce attached docs, skills, or diff/context payload.`
  );
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
