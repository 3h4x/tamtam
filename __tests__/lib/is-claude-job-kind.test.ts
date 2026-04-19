import { describe, it, expect } from 'vitest';
import { isClaudeJobKind } from '../../components/TerminalTab';

describe('isClaudeJobKind', () => {
  it.each(['run', 'review', 'fix', 'fix-ci', 'fix-push', 'release'])(
    'returns true for %s',
    (kind) => {
      expect(isClaudeJobKind(kind)).toBe(true);
    }
  );

  it('returns true for agent: prefixed kinds', () => {
    expect(isClaudeJobKind('agent:my-agent')).toBe(true);
    expect(isClaudeJobKind('agent:')).toBe(true);
  });

  it('returns false for unrelated kinds', () => {
    expect(isClaudeJobKind('test')).toBe(false);
    expect(isClaudeJobKind('push')).toBe(false);
    expect(isClaudeJobKind('deploy')).toBe(false);
    expect(isClaudeJobKind('commit')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isClaudeJobKind(undefined)).toBe(false);
  });

  it('does not match partial kind names', () => {
    // e.g. 'fix-push-extra' should not match 'fix-push' via substring
    expect(isClaudeJobKind('fix-push-extra')).toBe(false);
    expect(isClaudeJobKind('release-candidate')).toBe(false);
    // 'notfix-ci' should not match 'fix-ci'
    expect(isClaudeJobKind('notfix-ci')).toBe(false);
  });

  it('fix-push and release were not matched before — regression guard', () => {
    // These two are the new additions; ensure they are covered
    expect(isClaudeJobKind('fix-push')).toBe(true);
    expect(isClaudeJobKind('release')).toBe(true);
  });
});
