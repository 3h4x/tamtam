import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/config', () => ({
  getSettings: () => ({
    prompt_estimate_warn_tokens: 5,
    prompt_estimate_block_tokens: 10,
  }),
}));

vi.mock('@/lib/shared/usage-pricing', () => ({
  costUsd: ({ inputTokens }: { inputTokens: number }) => inputTokens / 1_000_000 * 3,
}));

describe('prompt cost estimator', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('estimates input tokens from utf8 bytes', async () => {
    const { estimatePromptCost } = await import('@/lib/jobs/prompt-size');

    const estimate = estimatePromptCost('12345678', { modelTier: 'fast' });

    expect(estimate.bytes).toBe(8);
    expect(estimate.estimatedInputTokens).toBe(2);
    expect(estimate.warning).toBe(false);
    expect(estimate.blocked).toBe(false);
    expect(estimate.modelTier).toBe('fast');
    expect(estimate.estimatedCostUsd).toBeCloseTo(0.000006);
  });

  it('warns below the hard block threshold', async () => {
    const { estimatePromptCost } = await import('@/lib/jobs/prompt-size');

    const estimate = estimatePromptCost('x'.repeat(24));

    expect(estimate.estimatedInputTokens).toBe(6);
    expect(estimate.warning).toBe(true);
    expect(estimate.blocked).toBe(false);
  });

  it('throws when the hard block threshold is exceeded', async () => {
    const { assertPromptEstimateAllowed, PromptEstimateBlockedError } = await import('@/lib/jobs/prompt-size');

    expect(() => assertPromptEstimateAllowed('x'.repeat(44))).toThrow(PromptEstimateBlockedError);
  });
});
