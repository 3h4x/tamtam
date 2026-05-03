import { describe, expect, it } from 'vitest';
import {
  getModelLabel,
  isCanonicalModelTier,
  isKnownModelAlias,
  normalizeModelInput,
  parseOptionalKnownModelInput,
  resolveModelAlias,
} from '@/lib/agents/model-aliases';

describe('model-aliases', () => {
  it('maps canonical tiers to themselves', () => {
    expect(resolveModelAlias('fast')).toBe('fast');
    expect(resolveModelAlias('normal')).toBe('normal');
    expect(resolveModelAlias('smart')).toBe('smart');
  });

  it('maps legacy claude aliases to canonical tiers', () => {
    expect(resolveModelAlias('haiku')).toBe('fast');
    expect(resolveModelAlias('sonnet')).toBe('normal');
    expect(resolveModelAlias('opus')).toBe('smart');
  });

  it('sanitizes unknown models to empty/fallback values', () => {
    expect(resolveModelAlias('gpt-5.5')).toBe('');
    expect(normalizeModelInput('claude-opus-4-1')).toBe('normal');
  });

  it('falls back when the input is empty', () => {
    expect(normalizeModelInput('')).toBe('normal');
    expect(normalizeModelInput(undefined, 'fast')).toBe('fast');
  });

  it('detects known aliases and canonical tiers', () => {
    expect(isKnownModelAlias('haiku')).toBe(true);
    expect(isKnownModelAlias('smart')).toBe(true);
    expect(isKnownModelAlias('gpt-5.4')).toBe(false);
    expect(isCanonicalModelTier('fast')).toBe(true);
    expect(isCanonicalModelTier('sonnet')).toBe(false);
  });

  it('renders provider-neutral labels', () => {
    expect(getModelLabel('haiku')).toBe('Fast');
    expect(getModelLabel('normal')).toBe('Normal');
    expect(getModelLabel('smart')).toBe('Smart');
  });

  it('parses optional known model inputs for write-boundary validation', () => {
    expect(parseOptionalKnownModelInput('sonnet', 'fast')).toEqual({ model: 'normal', error: null });
    expect(parseOptionalKnownModelInput('')).toEqual({ model: null, error: null });
    expect(parseOptionalKnownModelInput(undefined)).toEqual({ model: null, error: null });
    expect(parseOptionalKnownModelInput('smart --resume injected')).toEqual({
      model: null,
      error: 'Invalid model. Allowed values: fast, normal, smart, haiku, sonnet, opus.',
    });
  });
});
