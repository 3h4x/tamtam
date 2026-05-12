import { describe, it, expect } from 'vitest';
import {
  canonicalizeAgentName,
  getAgentNameValidationError,
  normalizeAgentNameInput,
  canonicalAgentNameKey,
} from '@/lib/agents/agent-name';

describe('canonicalizeAgentName', () => {
  it('trims surrounding whitespace', () => {
    expect(canonicalizeAgentName('  hello  ')).toBe('hello');
  });

  it('returns empty string when input is only whitespace', () => {
    expect(canonicalizeAgentName('   ')).toBe('');
  });

  it('preserves internal spaces', () => {
    expect(canonicalizeAgentName(' foo bar ')).toBe('foo bar');
  });
});

describe('getAgentNameValidationError', () => {
  it('returns null for a valid name', () => {
    expect(getAgentNameValidationError('my-agent')).toBeNull();
  });

  it('returns error when name is empty after trim', () => {
    expect(getAgentNameValidationError('   ')).toBe('name is required');
  });

  it('rejects forward slash', () => {
    expect(getAgentNameValidationError('foo/bar')).toMatch(/slash/);
  });

  it('rejects backslash', () => {
    expect(getAgentNameValidationError('foo\\bar')).toMatch(/slash/);
  });

  it('rejects control characters (char code < 32)', () => {
    expect(getAgentNameValidationError('foo\x01bar')).toMatch(/control/);
  });

  it('rejects DEL character (code 127)', () => {
    expect(getAgentNameValidationError('foo\x7fbar')).toMatch(/control/);
  });

  it('allows names with dots, hyphens, and underscores', () => {
    expect(getAgentNameValidationError('my-agent_v1.0')).toBeNull();
  });

  it('allows names with unicode letters', () => {
    expect(getAgentNameValidationError('tëst')).toBeNull();
  });
});

describe('normalizeAgentNameInput', () => {
  it('returns trimmed name and null error for valid string', () => {
    const result = normalizeAgentNameInput('  Deploy  ');
    expect(result).toEqual({ name: 'Deploy', error: null });
  });

  it('returns null name and error for non-string input', () => {
    expect(normalizeAgentNameInput(42)).toEqual({ name: null, error: 'name is required' });
    expect(normalizeAgentNameInput(null)).toEqual({ name: null, error: 'name is required' });
    expect(normalizeAgentNameInput(undefined)).toEqual({ name: null, error: 'name is required' });
  });

  it('returns error for empty string', () => {
    const result = normalizeAgentNameInput('');
    expect(result.error).toBe('name is required');
    // Empty string passes the typeof check so name is '' (trimmed), not null
    expect(result.name).toBe('');
  });

  it('returns error for slash in name', () => {
    const result = normalizeAgentNameInput('bad/name');
    expect(result.error).toMatch(/slash/);
  });
});

describe('canonicalAgentNameKey', () => {
  it('lowercases trimmed name', () => {
    expect(canonicalAgentNameKey('  MyAgent  ')).toBe('myagent');
  });

  it('preserves internal spaces after lowercasing', () => {
    expect(canonicalAgentNameKey(' Foo Bar ')).toBe('foo bar');
  });

  it('is idempotent', () => {
    const key = canonicalAgentNameKey('Deploy');
    expect(canonicalAgentNameKey(key)).toBe(key);
  });
});
