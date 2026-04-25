import { describe, it, expect } from 'vitest';
import { costUsd, totalTokens, PRICE_PER_MTOK } from '@/lib/usage-pricing';

describe('PRICE_PER_MTOK', () => {
  it('has expected price rates', () => {
    expect(PRICE_PER_MTOK.input).toBe(3);
    expect(PRICE_PER_MTOK.output).toBe(15);
    expect(PRICE_PER_MTOK.cacheWrite).toBe(3.75);
    expect(PRICE_PER_MTOK.cacheRead).toBe(0.3);
  });
});

describe('costUsd', () => {
  it('returns 0 for all-zero token counts', () => {
    expect(costUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })).toBe(0);
  });

  it('calculates input token cost correctly', () => {
    // 1M input tokens at $3/M = $3
    const cost = costUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
    expect(cost).toBeCloseTo(3.0, 6);
  });

  it('calculates output token cost correctly', () => {
    // 1M output tokens at $15/M = $15
    const cost = costUsd({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0 });
    expect(cost).toBeCloseTo(15.0, 6);
  });

  it('calculates cache write cost correctly', () => {
    // 1M cache create tokens at $3.75/M = $3.75
    const cost = costUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3.75, 6);
  });

  it('calculates cache read cost correctly', () => {
    // 1M cache read tokens at $0.30/M = $0.30
    const cost = costUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 });
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it('sums all token types correctly', () => {
    // 1M of each type: 3 + 15 + 3.75 + 0.30 = 22.05
    const cost = costUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(22.05, 6);
  });

  it('handles fractional token counts', () => {
    // 500k input at $3/M = $1.50
    const cost = costUsd({ inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
    expect(cost).toBeCloseTo(1.5, 6);
  });

  it('handles small token counts (typical small run)', () => {
    // 1000 input + 500 output: (1000*3 + 500*15) / 1M = (3000 + 7500) / 1M = $0.0105
    const cost = costUsd({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0 });
    expect(cost).toBeCloseTo(0.0105, 8);
  });
});

describe('totalTokens', () => {
  it('returns 0 for all-zero counts', () => {
    expect(totalTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })).toBe(0);
  });

  it('sums all token types', () => {
    expect(totalTokens({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheCreateTokens: 400 })).toBe(1000);
  });

  it('works with only input tokens', () => {
    expect(totalTokens({ inputTokens: 42, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })).toBe(42);
  });

  it('works with only output tokens', () => {
    expect(totalTokens({ inputTokens: 0, outputTokens: 99, cacheReadTokens: 0, cacheCreateTokens: 0 })).toBe(99);
  });

  it('works with only cache tokens', () => {
    expect(totalTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 50, cacheCreateTokens: 50 })).toBe(100);
  });
});
