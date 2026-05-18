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
  | { next: 'soak'; from: 'pr-wait'; soak: { mergeSha: string; prNumber: number; prRepo: string; prUrl: string; defaultBranch: string; watchMinutes: number; autoRevert: boolean } }
  | { next: 'done'; from: 'mark-dod' | 'pr-wait' | 'soak' | 'commit' | 'fix' | 'push' }
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
  /** Soak context. Provided after a successful pr-wait when the project
   *  has a positive `post_merge_watch_minutes`. When set, pr-wait routes
   *  to the new `soak` phase before the chain terminates. */
  soakContext?: { mergeSha: string; prNumber: number; prRepo: string; prUrl: string; defaultBranch: string; watchMinutes: number; autoRevert: boolean } | null;
}

import { TRANSITIONS, matchesPattern, buildNextPhase } from './pipeline-spec';

export function decideNextPhase(inputs: DecisionInputs): NextPhase {
  for (const t of TRANSITIONS) {
    if (t.external) continue;
    if (t.from !== inputs.kind) continue;
    if (!matchesPattern(inputs, t.when)) continue;
    return buildNextPhase(t, inputs);
  }
  return { next: 'unknown', from: inputs.kind, reason: `no decision rule for kind=${inputs.kind}` };
}
