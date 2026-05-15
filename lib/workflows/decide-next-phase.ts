// Pure decision logic for "after a sub-step finishes, what should happen next?"
//
// Decision rules:
//   test pass  → review
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
  | { next: 'commit'; from: 'review' | 'fix'; fileIssueForReviewId?: string }
  | { next: 'fix'; from: 'test'; testExitCode: number }
  | { next: 'fix'; from: 'review'; verdict: 'NEEDS ATTENTION' | 'DO NOT SHIP' }
  | { next: 'fix'; from: 'commit' }
  | { next: 'fix'; from: 'push' }
  | { next: 'push'; from: 'commit' | 'fix' }
  | { next: 'abort'; from: 'review'; verdict: 'DO NOT SHIP' | 'NEEDS ATTENTION'; stopReason?: string }
  | { next: 'mark-dod'; from: 'push' }
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
}

export function decideNextPhase(inputs: DecisionInputs): NextPhase {
  const { kind, exitCode, verdict, parentKind } = inputs;

  if (kind === 'test') {
    return exitCode === 0
      ? { next: 'review', from: 'test' }
      : { next: 'fix', from: 'test', testExitCode: exitCode };
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
  if (kind === 'mark-dod' || kind === 'pr-wait') {
    return { next: 'done', from: kind };
  }
  return { next: 'unknown', from: kind, reason: `no decision rule for kind=${kind}` };
}
