import { describe, expect, it } from 'vitest';
import { extractCriteria } from '@/lib/pipeline/start-mark-dod';
import {
  ISSUE_BODY_TEMPLATE,
  ISSUE_FORMAT_INSTRUCTION,
  normalizeAcceptanceCriteria,
} from '@/lib/agents/issue-template';

describe('issue-template', () => {
  it('exports the canonical issue body skeleton', () => {
    expect(ISSUE_BODY_TEMPLATE).toContain('## Problem');
    expect(ISSUE_BODY_TEMPLATE).toContain('## Proposed approach');
    expect(ISSUE_BODY_TEMPLATE).toContain('## Acceptance criteria');
    expect((ISSUE_BODY_TEMPLATE.match(/^- \[ \]/gm) ?? [])).toHaveLength(2);
    expect(ISSUE_FORMAT_INSTRUCTION).toContain(ISSUE_BODY_TEMPLATE);
  });

  it('normalizes plain bullets under acceptance criteria to unchecked checkboxes', () => {
    const body = [
      '## Problem',
      '- leave this bullet alone',
      '',
      '## Acceptance criteria',
      '- first criterion',
      '* second criterion',
    ].join('\n');

    expect(normalizeAcceptanceCriteria(body)).toBe([
      '## Problem',
      '- leave this bullet alone',
      '',
      '## Acceptance criteria',
      '- [ ] first criterion',
      '* [ ] second criterion',
    ].join('\n'));
  });

  it('is idempotent', () => {
    const body = [
      '## Acceptance criteria',
      '- first criterion',
      '- [ ] second criterion',
    ].join('\n');

    const normalized = normalizeAcceptanceCriteria(body);
    expect(normalizeAcceptanceCriteria(normalized)).toBe(normalized);
  });

  it('leaves bullets in other sections untouched', () => {
    const body = [
      '## Problem',
      '- plain problem bullet',
      '',
      '## Proposed approach',
      '* plan bullet',
      '',
      '## Acceptance criteria',
      '- criterion',
    ].join('\n');

    const normalized = normalizeAcceptanceCriteria(body);
    expect(normalized).toContain('## Problem\n- plain problem bullet');
    expect(normalized).toContain('## Proposed approach\n* plan bullet');
    expect(normalized).toContain('## Acceptance criteria\n- [ ] criterion');
  });

  it('leaves already-checked criteria unchanged', () => {
    const body = [
      '## Acceptance criteria',
      '- [x] done',
      '- [ ] todo',
    ].join('\n');

    expect(normalizeAcceptanceCriteria(body)).toBe(body);
  });

  it('round-trips into extractCriteria after normalization', () => {
    const normalized = normalizeAcceptanceCriteria([
      '## Acceptance criteria',
      '- first criterion',
      '* second criterion',
      '## Next section',
      '- untouched',
    ].join('\n'));

    expect(extractCriteria(normalized)).toEqual([
      { raw: '- [ ] first criterion', text: 'first criterion' },
      { raw: '* [ ] second criterion', text: 'second criterion' },
    ]);
  });
});
