import { describe, it, expect } from 'vitest';
import { isSubjectToDiffGates } from '@/lib/agents/roles';

describe('isSubjectToDiffGates', () => {
  it('gates a normal user producer', () => {
    expect(isSubjectToDiffGates({ kind: 'user', role: 'producer' })).toBe(true);
  });
  it('exempts a user monitor (0-diff by design)', () => {
    expect(isSubjectToDiffGates({ kind: 'user', role: 'monitor' })).toBe(false);
  });
  it('exempts reviewers and planners too', () => {
    expect(isSubjectToDiffGates({ kind: 'user', role: 'reviewer' })).toBe(false);
    expect(isSubjectToDiffGates({ kind: 'user', role: 'planner' })).toBe(false);
  });
  it('exempts system agents regardless of role', () => {
    expect(isSubjectToDiffGates({ kind: 'system', role: 'producer' })).toBe(false);
  });
});
