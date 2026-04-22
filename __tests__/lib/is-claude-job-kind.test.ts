import { describe, it, expect } from 'vitest';
import { isClaudeJobKind } from '../../components/TerminalTab';

describe('isClaudeJobKind', () => {
  it.each(['run', 'review', 'fix', 'fix-ci', 'fix-push'])(
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

  it('returns false for release — its log is an aggregate of child output', () => {
    // Release logs are a mix of plain text (test output, commit/push) and
    // NDJSON (review/fix). Stream-json parsing would drop the plain-text
    // sections, so the terminal serves them raw. Guard this.
    expect(isClaudeJobKind('release')).toBe(false);
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
});
