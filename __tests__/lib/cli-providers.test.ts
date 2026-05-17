import { describe, expect, it } from 'vitest';
import {
  CLI_PROVIDERS,
  CLI_PROVIDERS_WITH_QUOTA,
  encodeEnabledProviders,
  isCliProvider,
  parseEnabledProviders,
} from '@/lib/usage/cli-providers';

describe('cli-providers', () => {
  it('exposes the expected provider constants', () => {
    expect(CLI_PROVIDERS).toEqual(['claude', 'codex', 'gemini', 'lmstudio', 'deepagents']);
    expect(CLI_PROVIDERS_WITH_QUOTA).toEqual(['claude', 'codex']);
  });

  it('recognizes only valid provider ids', () => {
    expect(isCliProvider('claude')).toBe(true);
    expect(isCliProvider('lmstudio')).toBe(true);
    expect(isCliProvider('deepagents')).toBe(true);
    expect(isCliProvider('Claude')).toBe(false);
    expect(isCliProvider('openai')).toBe(false);
    expect(isCliProvider(null)).toBe(false);
  });

  it('parses comma and whitespace separated provider lists and ignores invalid entries', () => {
    expect(parseEnabledProviders(' Claude, codex  gemini,\nLMSTUDIO deepagents invalid ')).toEqual([
      'claude',
      'codex',
      'gemini',
      'lmstudio',
      'deepagents',
    ]);
  });

  it('returns an empty list for missing config values', () => {
    expect(parseEnabledProviders(undefined)).toEqual([]);
    expect(parseEnabledProviders(null)).toEqual([]);
    expect(parseEnabledProviders('')).toEqual([]);
  });

  it('encodes providers as a stable deduped comma-separated list', () => {
    expect(encodeEnabledProviders(['codex', 'claude', 'codex', 'gemini'])).toBe(
      'codex,claude,gemini',
    );
  });
});
