// Pure decision logic for "after a sub-step finishes, what should happen next?"
//
// Extracted from releaseObservationWorkflow's decideNextPhaseStep so the
// rules can be tested without mocking the jobs cache and so the same logic
// can eventually be reused by runCompletionHooks (lib/jobs/lifecycle.ts) to
// keep workflow-driven and hook-driven paths in lock-step.
//
// Decision rules mirror what runCompletionHooks does today:
//   test pass  → review
//   test fail  → fix
//   review LGTM           → push
//   review NEEDS ATTENTION → fix
//   review DO NOT SHIP     → abort
//   review null verdict    → fix  (treat as NEEDS ATTENTION per review-contract)
//   push pass  → mark-dod
//   push fail  → fix-push  (likely hook rejection; pipeline retries push)
//   commit/fix/fix-push/mark-dod/pr-wait → done
//   anything else          → unknown (safe fallback, e.g. release meta-job)

export type NextPhase =
  | { next: 'review'; from: 'test' }
  | { next: 'fix'; from: 'test'; testExitCode: number }
  | { next: 'fix'; from: 'review'; verdict: 'NEEDS ATTENTION' }
  | { next: 'push'; from: 'review' }
  | { next: 'abort'; from: 'review'; verdict: 'DO NOT SHIP' }
  | { next: 'fix-push'; from: 'push' }
  | { next: 'mark-dod'; from: 'push' }
  | { next: 'done'; from: 'mark-dod' | 'pr-wait' | 'commit' | 'fix' | 'fix-push' | 'push' }
  | { next: 'unknown'; from: string; reason: string };

export interface DecisionInputs {
  kind: string;
  exitCode: number;
  /** Review verdict — only meaningful when kind === 'review'. Pass null
   *  when getVerdict() returns null (review didn't emit one — treat as
   *  NEEDS ATTENTION). */
  verdict: string | null;
}

export function decideNextPhase(inputs: DecisionInputs): NextPhase {
  const { kind, exitCode, verdict } = inputs;

  if (kind === 'test') {
    return exitCode === 0
      ? { next: 'review', from: 'test' }
      : { next: 'fix', from: 'test', testExitCode: exitCode };
  }
  if (kind === 'review') {
    if (verdict === 'LGTM') return { next: 'push', from: 'review' };
    if (verdict === 'DO NOT SHIP') return { next: 'abort', from: 'review', verdict: 'DO NOT SHIP' };
    return { next: 'fix', from: 'review', verdict: 'NEEDS ATTENTION' };
  }
  if (kind === 'push') {
    return exitCode === 0
      ? { next: 'mark-dod', from: 'push' }
      : { next: 'fix-push', from: 'push' };
  }
  if (kind === 'fix' || kind === 'fix-push' || kind === 'commit' || kind === 'mark-dod' || kind === 'pr-wait') {
    return { next: 'done', from: kind };
  }
  return { next: 'unknown', from: kind, reason: `no decision rule for kind=${kind}` };
}
