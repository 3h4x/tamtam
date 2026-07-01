import { describe, expect, it } from 'vitest';
import { validateAgentActions } from '@/lib/agents/action-schema';

describe('validateAgentActions — merge-pr', () => {
  it('accepts a well-formed merge-pr action', () => {
    const r = validateAgentActions({ actions: [{ type: 'merge-pr', prNumber: 77, issue: 42 }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions[0]).toEqual({ type: 'merge-pr', prNumber: 77, issue: 42 });
  });

  it('accepts an optional mergeMethod', () => {
    const r = validateAgentActions({ actions: [{ type: 'merge-pr', prNumber: 5, issue: 3, mergeMethod: 'squash' }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions[0]).toMatchObject({ mergeMethod: 'squash' });
  });

  it('rejects a missing prNumber', () => {
    const r = validateAgentActions({ actions: [{ type: 'merge-pr', issue: 42 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('prNumber');
  });

  it('rejects a missing issue linkage', () => {
    const r = validateAgentActions({ actions: [{ type: 'merge-pr', prNumber: 77 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('issue');
  });

  it('rejects an invalid mergeMethod', () => {
    const r = validateAgentActions({ actions: [{ type: 'merge-pr', prNumber: 77, issue: 42, mergeMethod: 'fast-forward' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('mergeMethod');
  });
});
