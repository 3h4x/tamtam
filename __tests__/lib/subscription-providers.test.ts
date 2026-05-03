import { describe, expect, it } from 'vitest';
import {
  encodeBudgetSubscriptionProviders,
  normalizeBudgetSubscriptionProviders,
} from '@/lib/usage/subscription-providers';

describe('subscription-providers', () => {
  it('defaults to both supported providers when unset', () => {
    expect(normalizeBudgetSubscriptionProviders(undefined)).toEqual(['claude', 'codex']);
  });

  it('deduplicates and preserves valid provider order', () => {
    expect(normalizeBudgetSubscriptionProviders('codex,claude,codex')).toEqual(['codex', 'claude']);
  });

  it('ignores invalid entries and falls back when nothing valid remains', () => {
    expect(normalizeBudgetSubscriptionProviders('gemini custom')).toEqual(['claude', 'codex']);
  });

  it('encodes an empty selection back to the default tracked set', () => {
    expect(encodeBudgetSubscriptionProviders([])).toBe('claude,codex');
  });
});
