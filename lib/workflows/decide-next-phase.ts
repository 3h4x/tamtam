// Pure decision logic for "after a sub-step finishes, what should happen next?"
//
// Decision rules:
//   test pass  → review (or commit/push when review is disabled)
//   test fail  → fix
//   review LGTM           → push
//   review NEEDS ATTENTION → fix
//   review DO NOT SHIP     → abort
//   review null verdict    → fix  (treat as NEEDS ATTENTION per review-contract)
//   push pass  → mark-dod
//   push fail  → fix  (the generic fix phase reads the failing source job's
//                      log to decide what to fix — same workflow handles
//                      test failures, review findings, and hook rejections)
//   commit pass → push      (chain into the next pipeline step)
//   commit fail → fix       (re-fix and try the commit again)
//   fix pass    → re-verify the parent step that triggered the fix:
//                   parent test    → next: 'test'    (was the bug really fixed?)
//                   parent review  → next: 'review'  (do the findings hold?)
//                   parent commit  → next: 'commit'  (does the hook still reject?)
//                   parent push    → next: 'push'    (does the hook still reject?)
//                   no parent      → done
//   mark-dod/pr-wait → done
//   anything else          → unknown (safe fallback, e.g. release meta-job)

export type NextPhase =
  | { next: 'test'; from: 'fix' }
  | { next: 'review'; from: 'test' | 'fix' }
  | { next: 'commit'; from: 'test' | 'review' | 'fix'; fileIssueForReviewId?: string }
  | { next: 'fix'; from: 'test'; testExitCode: number }
  | { next: 'fix'; from: 'review'; verdict: 'NEEDS ATTENTION' | 'DO NOT SHIP' }
  | { next: 'fix'; from: 'commit' }
  | { next: 'fix'; from: 'push' }
  | { next: 'push'; from: 'test' | 'commit' | 'fix' }
  | { next: 'abort'; from: 'review'; verdict: 'DO NOT SHIP' | 'NEEDS ATTENTION'; stopReason?: string }
  | { next: 'mark-dod'; from: 'push' }
  | { next: 'pr-wait'; from: 'mark-dod' | 'push'; pr: { prNumber: number; prRepo: string; prUrl: string } }
  | { next: 'done'; from: 'mark-dod' | 'pr-wait' | 'commit' | 'fix' | 'push' }
  | { next: 'unknown'; from: string; reason: string };

export interface DecisionInputs {
  kind: string;
  exitCode: number;
  /** Review verdict — only meaningful when kind === 'review'. Pass null
   *  when getVerdict() returns null (review didn't emit one — treat as
   *  NEEDS ATTENTION). */
  verdict: string | null;
  /** Parent kind for 'fix' completions — drives re-verification routing.
   *  When kind === 'fix' and parentKind is set, decideNextPhase routes back
   *  to the parent step kind for re-verification (e.g. fix-from-push → push).
   *  Null/undefined parent → fix terminates as 'done'. */
  parentKind?: string | null;
  /** PR context from the release's `push` job, when the push opened or
   *  reused a PR. Used to route mark-dod → pr-wait under auto-merge. */
  pushPrContext?: { prNumber: number; prRepo: string; prUrl: string } | null;
  /** Project's `auto_pr_merge_enabled` flag. When true and the push
   *  produced a PR, the orchestrator continues into pr-wait after mark-dod
   *  (or after push when mark-dod is skipped). */
  autoPrMergeEnabled?: boolean;
  /** Project-level review off-switch. When true, a passing test should
   *  skip the review phase and keep release side effects moving. */
  reviewDisabled?: boolean;
  /** Whether the project worktree has uncommitted changes after test. */
  hasUncommittedChanges?: boolean;
  /** Whether the current branch has local commits not pushed upstream. */
  hasUnpushedCommits?: boolean;
}

export function decideNextPhase(inputs: DecisionInputs): NextPhase {
  const {
    kind,
    exitCode,
    verdict,
    parentKind,
    pushPrContext,
    autoPrMergeEnabled,
    reviewDisabled,
    hasUncommittedChanges,
    hasUnpushedCommits,
  } = inputs;

  if (kind === 'test') {
    if (exitCode !== 0) {
      return { next: 'fix', from: 'test', testExitCode: exitCode };
    }
    if (reviewDisabled) {
      if (hasUncommittedChanges) return { next: 'commit', from: 'test' };
      if (hasUnpushedCommits) return { next: 'push', from: 'test' };
      return { next: 'push', from: 'test' };
    }
    return { next: 'review', from: 'test' };
  }
  if (kind === 'review') {
    if (verdict === 'LGTM') {
      // Route through commit so any agent-produced uncommitted edits land
      // in a real commit before the push step. Without this, start-push
      // returns "No changes to push" when the working tree has untracked
      // files (the agent generated files but didn't commit them — by
      // design; the pipeline owns commit+push).
      return { next: 'commit', from: 'review' };
    }
    if (verdict === 'DO NOT SHIP') {
      return {
        next: 'abort',
        from: 'review',
        verdict: 'DO NOT SHIP',
        stopReason: 'review verdict: DO NOT SHIP — release blocked',
      };
    }
    return { next: 'fix', from: 'review', verdict: 'NEEDS ATTENTION' };
  }
  if (kind === 'commit') {
    return exitCode === 0
      ? { next: 'push', from: 'commit' }
      : { next: 'fix', from: 'commit' };
  }
  if (kind === 'push') {
    return exitCode === 0
      ? { next: 'mark-dod', from: 'push' }
      : { next: 'fix', from: 'push' };
  }
  if (kind === 'fix') {
    // Re-verify the step that triggered the fix. A successful fix doesn't
    // mean the underlying problem is solved — it means the model claims
    // it solved it. The parent step is the source of truth.
    if (parentKind === 'test')   return { next: 'test',   from: 'fix' };
    if (parentKind === 'review') return { next: 'review', from: 'fix' };
    if (parentKind === 'commit') return { next: 'commit', from: 'fix' };
    if (parentKind === 'push')   return { next: 'push',   from: 'fix' };
    return { next: 'done', from: 'fix' };
  }
  if (kind === 'mark-dod') {
    // After DoD verification on an auto-merge-enabled, PR-backed push,
    // continue into pr-wait so CI is polled and the PR is merged
    // automatically.
    //
    // Mark-dod exit code is intentionally ignored here. Mark-dod's job is
    // to tick acceptance-criteria checkboxes in the issue/PR body — it
    // does NOT block the release; the push already landed. A non-zero
    // exit (most often a PM2 restart killing the inline mark-dod process)
    // must not skip pr-wait, otherwise the auto-merge release stops with
    // a stranded open PR and no one polls it to completion.
    if (autoPrMergeEnabled && pushPrContext) {
      return { next: 'pr-wait', from: 'mark-dod', pr: pushPrContext };
    }
    return { next: 'done', from: 'mark-dod' };
  }
  if (kind === 'pr-wait') {
    return { next: 'done', from: 'pr-wait' };
  }
  return { next: 'unknown', from: kind, reason: `no decision rule for kind=${kind}` };
}
