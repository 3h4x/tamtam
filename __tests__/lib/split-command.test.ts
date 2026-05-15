import { describe, it, expect } from 'vitest';
import { splitCommand } from '@/lib/shared/split-command';

describe('splitCommand', () => {
  it('splits on whitespace', () => {
    expect(splitCommand('claude --model opus --print')).toEqual(['claude', '--model', 'opus', '--print']);
  });

  it('preserves double-quoted segments', () => {
    expect(splitCommand('claude --param "hello world"')).toEqual(['claude', '--param', 'hello world']);
  });

  it('preserves single-quoted segments', () => {
    expect(splitCommand("claude --param 'spaced value'")).toEqual(['claude', '--param', 'spaced value']);
  });

  it('handles backslash escapes inside quotes', () => {
    expect(splitCommand('claude --x "a\\"b"')).toEqual(['claude', '--x', 'a"b']);
  });

  it('returns empty array for empty / whitespace-only input', () => {
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('   ')).toEqual([]);
  });
});
