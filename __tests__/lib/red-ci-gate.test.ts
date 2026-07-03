import { describe, it, expect } from 'vitest';
import { shouldBlockReleaseOnRedCi } from '@/lib/pipeline/red-ci-gate';

function base(overrides: Partial<Parameters<typeof shouldBlockReleaseOnRedCi>[0]> = {}) {
  return {
    blockEnabled: true,
    operatorInitiated: false,
    sourceJobKind: null,
    ci: 'failure',
    ...overrides,
  };
}

describe('shouldBlockReleaseOnRedCi', () => {
  it('blocks an automatic feature release when default-branch CI is failing', () => {
    expect(shouldBlockReleaseOnRedCi(base())).toBe(true);
  });

  it('does NOT block when CI is green / in-progress / unknown', () => {
    expect(shouldBlockReleaseOnRedCi(base({ ci: 'success' }))).toBe(false);
    expect(shouldBlockReleaseOnRedCi(base({ ci: 'in_progress' }))).toBe(false);
    expect(shouldBlockReleaseOnRedCi(base({ ci: 'pending' }))).toBe(false);
    expect(shouldBlockReleaseOnRedCi(base({ ci: null }))).toBe(false);
  });

  it('does NOT block the fix-ci-chained release — it carries the CI fix (would deadlock)', () => {
    expect(shouldBlockReleaseOnRedCi(base({ sourceJobKind: 'fix-ci' }))).toBe(false);
  });

  it('does NOT block an operator-initiated (manual Release button) release', () => {
    expect(shouldBlockReleaseOnRedCi(base({ operatorInitiated: true }))).toBe(false);
  });

  it('does NOT block when the kill-switch setting is off', () => {
    expect(shouldBlockReleaseOnRedCi(base({ blockEnabled: false }))).toBe(false);
  });

  it('still blocks an ordinary agent/run-sourced release (only fix-ci is exempt)', () => {
    expect(shouldBlockReleaseOnRedCi(base({ sourceJobKind: 'agent:issue-cruncher' }))).toBe(true);
    expect(shouldBlockReleaseOnRedCi(base({ sourceJobKind: 'run' }))).toBe(true);
  });
});
