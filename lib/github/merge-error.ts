// Classify `gh pr merge` stderr so callers can react correctly instead of
// blindly retrying with `--auto`. The bug this prevents: a merge CONFLICT
// ("Pull request #N is not mergeable: the merge commit cannot be cleanly
// created") contains the substring "mergeable", so a naive
// /mergeable|pending/ test treats it as "checks pending" and retries with
// `--auto`. On a repo without auto-merge enabled that retry then fails with a
// misleading "Auto merge is not allowed for this repository", masking the real
// reason (the branch has conflicts and needs a rebase). Shared by the HTTP
// merge route and the agent-action orchestrator's merge-pr helper.

/**
 * True when the merge was refused because the branch conflicts with its base
 * (`gh`/GitHub cannot create a clean merge commit). `--auto` never fixes this —
 * it only defers a merge until checks pass; it cannot resolve code conflicts.
 */
export function isMergeConflictError(stderr: string): boolean {
  // Match the conflict-SPECIFIC phrasing, not the generic "not mergeable:"
  // prefix — gh reuses that prefix for pending checks too
  // ("not mergeable: required status checks have not passed").
  return /cannot be cleanly created|merge conflict|conflicts with the base|CONFLICT \(/i.test(stderr);
}

/**
 * True when the only blocker is that required status checks have not finished —
 * the one case where falling back to `gh pr merge --auto` (merge-when-green) is
 * the right move. Deliberately excludes conflicts (which contain "mergeable")
 * and "auto merge is not allowed" (a repo-config error, not a pending state).
 */
export function isChecksPendingError(stderr: string): boolean {
  if (isMergeConflictError(stderr)) return false;
  if (/not allowed/i.test(stderr)) return false;
  return /required status check|checks? (are |have )?(not )?(passed|pending)|still pending|not yet/i.test(stderr);
}

/**
 * Turn raw `gh pr merge` stderr into an operator-actionable message. For a
 * conflict, spell out the fix (rebase + resolve) instead of leaking gh's terse
 * (or, post-`--auto`, misleading) wording. Everything else passes through.
 */
export function friendlyMergeError(prNumber: number, stderr: string): string {
  const raw = stderr.trim();
  if (isMergeConflictError(raw)) {
    return `PR #${prNumber} has merge conflicts with its base branch and can't be merged automatically. Rebase the branch onto the base branch, resolve the conflicts, and push — then merge. (${raw})`;
  }
  return raw || 'merge failed';
}
