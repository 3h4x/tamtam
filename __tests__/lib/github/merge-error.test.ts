import { describe, it, expect } from 'vitest';
import {
  isMergeConflictError,
  isChecksPendingError,
  friendlyMergeError,
} from '@/lib/github/merge-error';

// The exact stderr GitHub CLI returns for a conflicting PR (verified against a
// real diverged branch): note it contains the substring "mergeable" inside
// "not mergeable" — the trap the old /mergeable/ regex fell into.
const CONFLICT = 'Pull request owner/repo#85 is not mergeable: the merge commit cannot be cleanly created.';
const PENDING = 'Pull request #4343 is not mergeable: required status checks have not passed.';
const AUTO_NOT_ALLOWED = 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)';

describe('isMergeConflictError', () => {
  it('detects a conflict / uncleanly-mergeable branch', () => {
    expect(isMergeConflictError(CONFLICT)).toBe(true);
    expect(isMergeConflictError('CONFLICT (content): merge conflict in src/server.js')).toBe(true);
  });
  it('does not flag a pending-checks or auto-merge error as a conflict', () => {
    expect(isMergeConflictError('required status checks have not passed')).toBe(false);
    expect(isMergeConflictError(AUTO_NOT_ALLOWED)).toBe(false);
  });
});

describe('isChecksPendingError', () => {
  it('is true only for genuine pending required checks (the --auto case)', () => {
    expect(isChecksPendingError('required status checks have not passed')).toBe(true);
    expect(isChecksPendingError(PENDING)).toBe(true);
  });
  it('is false for a conflict even though the message contains "mergeable"', () => {
    // This is the regression: the old code retried --auto here and surfaced a
    // misleading "Auto merge is not allowed" error.
    expect(isChecksPendingError(CONFLICT)).toBe(false);
  });
  it('is false for "auto merge is not allowed" (repo config, not pending)', () => {
    expect(isChecksPendingError(AUTO_NOT_ALLOWED)).toBe(false);
  });
});

describe('friendlyMergeError', () => {
  it('rewrites a conflict into an actionable rebase instruction and keeps the raw detail', () => {
    const msg = friendlyMergeError(85, CONFLICT);
    expect(msg).toContain('#85');
    expect(msg.toLowerCase()).toContain('conflict');
    expect(msg.toLowerCase()).toContain('rebase');
    expect(msg).toContain(CONFLICT); // raw gh text preserved for debugging
  });
  it('passes non-conflict errors through unchanged', () => {
    expect(friendlyMergeError(1, AUTO_NOT_ALLOWED)).toBe(AUTO_NOT_ALLOWED);
    expect(friendlyMergeError(1, '')).toBe('merge failed');
  });
});
