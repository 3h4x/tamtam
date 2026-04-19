import { describe, it, expect } from 'vitest';
import { hasAnsi, renderAnsi } from '@/lib/ansi-render';

describe('hasAnsi', () => {
  it('returns false for plain text', () => {
    expect(hasAnsi('hello world')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasAnsi('')).toBe(false);
  });

  it('returns false for text with exactly one ANSI sequence', () => {
    expect(hasAnsi('\x1b[32mhello')).toBe(false);
  });

  it('returns true for text with two ANSI sequences', () => {
    expect(hasAnsi('\x1b[32mhello\x1b[0m')).toBe(true);
  });

  it('returns true for multiple color codes', () => {
    expect(hasAnsi('\x1b[1m\x1b[32mBold green\x1b[0m')).toBe(true);
  });

  it('handles optional leading ESC (bracket-only sequences)', () => {
    // The regex allows the ESC to be optional
    expect(hasAnsi('[32mfoo[0m')).toBe(true);
  });
});

describe('renderAnsi', () => {
  it('returns plain text as a single string element', () => {
    const result = renderAnsi('hello') as any[];
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('hello');
  });

  it('returns empty array for empty string', () => {
    const result = renderAnsi('') as any[];
    expect(result).toHaveLength(0);
  });

  it('wraps colored text in a span with correct color style', () => {
    // FG[32] = '#a7c080' (green)
    const result = renderAnsi('\x1b[32mgreen\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0].type).toBe('span');
    expect(spans[0].props.style.color).toBe('#a7c080');
    expect(spans[0].props.children).toBe('green');
  });

  it('applies bold style for code 1', () => {
    const result = renderAnsi('\x1b[1mBold\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans[0].props.style.fontWeight).toBe('bold');
  });

  it('applies dim (opacity 0.6) for code 2', () => {
    const result = renderAnsi('\x1b[2mDim\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans[0].props.style.opacity).toBe(0.6);
  });

  it('applies italic style for code 3', () => {
    const result = renderAnsi('\x1b[3mItalic\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans[0].props.style.fontStyle).toBe('italic');
  });

  it('applies underline style for code 4', () => {
    const result = renderAnsi('\x1b[4mUnderline\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans[0].props.style.textDecoration).toBe('underline');
  });

  it('resets all styles on code 0 — trailing text is unstyled', () => {
    const result = renderAnsi('\x1b[32mcolored\x1b[0mplain') as any[];
    // The last part ('plain') should be a bare string, not a span
    const last = result[result.length - 1];
    expect(typeof last).toBe('string');
    expect(last).toBe('plain');
  });

  it('handles background color codes', () => {
    // BG[41] = '#5a2a2a' (dark red bg)
    const result = renderAnsi('\x1b[41mbg\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans[0].props.style.backgroundColor).toBe('#5a2a2a');
  });

  it('applies bright colors (90-97 range)', () => {
    // FG[91] = '#e28d8d' (bright red)
    const result = renderAnsi('\x1b[91mbright red\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans[0].props.style.color).toBe('#e28d8d');
  });

  it('produces multiple spans for multiple colored segments', () => {
    const result = renderAnsi('\x1b[32mA\x1b[0m\x1b[31mB\x1b[0m') as any[];
    const spans = result.filter((p: any) => p !== null && typeof p === 'object');
    expect(spans.length).toBe(2);
    expect(spans[0].props.style.color).toBe('#a7c080'); // green
    expect(spans[1].props.style.color).toBe('#cc6666'); // red
  });

  it('handles text before and after color codes', () => {
    const result = renderAnsi('before\x1b[32mmiddle\x1b[0mafter') as any[];
    // Should have: 'before', span('middle'), 'after'
    expect(result[0]).toBe('before');
    const span = result[1] as any;
    expect(span.type).toBe('span');
    expect(span.props.children).toBe('middle');
    const trailing = result[result.length - 1];
    expect(trailing).toBe('after');
  });

  it('clears bold with code 22', () => {
    const result = renderAnsi('\x1b[1mbold\x1b[22mnormal') as any[];
    const strings = result.filter((p: any) => typeof p === 'string');
    expect(strings).toContain('normal');
  });
});
