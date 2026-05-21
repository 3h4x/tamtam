import { describe, expect, it } from 'vitest';
import { extractCriteria, tickCriteria } from '@/lib/pipeline/mark-dod-criteria';

describe('extractCriteria', () => {
  it('returns an empty array when no checkboxes are present', () => {
    expect(extractCriteria('Just prose, no list.')).toEqual([]);
  });

  it('extracts unchecked checkboxes with leading dash bullets', () => {
    const body = `
- [ ] First item
- [ ] Second item
`.trim();
    const out = extractCriteria(body);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ raw: '- [ ] First item', text: 'First item' });
    expect(out[1]).toEqual({ raw: '- [ ] Second item', text: 'Second item' });
  });

  it('extracts unchecked checkboxes with leading asterisk bullets', () => {
    const body = `* [ ] Asterisk style item`;
    const out = extractCriteria(body);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Asterisk style item');
  });

  it('extracts indented (nested) checkboxes', () => {
    const body = `
- [ ] Top-level
  - [ ] Nested
    - [ ] Deeper
`.trim();
    expect(extractCriteria(body).map((c) => c.text)).toEqual(['Top-level', 'Nested', 'Deeper']);
  });

  it('ignores already-checked items (regex requires `[ ]` not `[x]`)', () => {
    const body = `
- [x] Already done
- [ ] Still pending
`.trim();
    const out = extractCriteria(body);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Still pending');
  });

  it('preserves the raw source line for later string replacement', () => {
    const body = '  -  [ ]    spaced  out  item';
    const out = extractCriteria(body);
    expect(out).toHaveLength(1);
    // The raw stores the original line; the text strips trailing whitespace.
    expect(out[0].raw).toBe('  -  [ ]    spaced  out  item');
    expect(out[0].text).toBe('spaced  out  item');
  });
});

describe('tickCriteria', () => {
  it('returns the body unchanged and ticked=0 when no matches', () => {
    const body = `- [ ] One\n- [ ] Two`;
    const result = tickCriteria(body, new Set(['Three']));
    expect(result.ticked).toBe(0);
    expect(result.body).toBe(body);
  });

  it('ticks matching items and returns the count', () => {
    const body = `- [ ] First\n- [ ] Second\n- [ ] Third`;
    const result = tickCriteria(body, new Set(['First', 'Third']));
    expect(result.ticked).toBe(2);
    expect(result.body).toBe(`- [x] First\n- [ ] Second\n- [x] Third`);
  });

  it('preserves the original whitespace and bullet character around the tick', () => {
    const body = `  *   [ ]   Item with spaces`;
    const result = tickCriteria(body, new Set(['Item with spaces']));
    expect(result.body).toBe(`  *   [x]   Item with spaces`);
    expect(result.ticked).toBe(1);
  });

  it('does NOT re-tick already-checked items', () => {
    const body = `- [x] Done\n- [ ] Pending`;
    const result = tickCriteria(body, new Set(['Done', 'Pending']));
    // Only "Pending" gets newly ticked; the already-checked line is untouched.
    expect(result.ticked).toBe(1);
    expect(result.body).toBe(`- [x] Done\n- [x] Pending`);
  });

  it('matches exact text only (case-sensitive, whitespace-trimmed)', () => {
    // The set has "Item" but the line text is "item" (lowercase) — no match.
    const body = `- [ ] item`;
    expect(tickCriteria(body, new Set(['Item'])).ticked).toBe(0);
    // The set has "Done" (trimmed) and the line has trailing whitespace —
    // extractCriteria/tickCriteria both `.trim()` the captured text.
    const body2 = `- [ ] Done   `;
    expect(tickCriteria(body2, new Set(['Done'])).ticked).toBe(1);
  });

  it('leaves non-checkbox lines alone', () => {
    const body = `
## Acceptance criteria
- [ ] Real criterion

Some prose here.

  Not a checkbox.
`.trim();
    const result = tickCriteria(body, new Set(['Real criterion']));
    expect(result.body).toContain('- [x] Real criterion');
    expect(result.body).toContain('## Acceptance criteria');
    expect(result.body).toContain('Some prose here.');
    expect(result.body).toContain('Not a checkbox.');
  });
});
