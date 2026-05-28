// Pre-dispatch guard layer for the workflow-driven release pipeline.
//
// Sits between `decideNextPhase` and `dispatchPhase` in the orchestrator.
// `decideNextPhase` is pure — it answers "given just the kind+exit+verdict
// of the just-finished step, what should run next?". The guards add the
// state-dependent context that pure decision logic can't see:
//
//   - Has the fix loop converged or are we re-flagging the same findings?
//     (reviewIsStuck / fixContradictsReview)
//   - Have we hit per-release iteration caps for review/test/commit/push?
//     (checkIterationCap)
//   - Should a DO NOT SHIP review abort, route through fix, or file a
//     follow-up issue and continue to commit?
//     (reviewDoNotShipAction / fileIssueForReviewId)
//
// When a guard trips, the dispatch decision is rewritten to
// `{ next: 'abort', stopReason }`. The orchestrator's terminal-decision
// branch picks that up, persists the stop reason on the release meta-job,
// and finalizes the release as failed.
//
// The guards lift the equivalent logic out of `lib/jobs/lifecycle.ts`'s
// completion-hook chain. The legacy hook still runs for standalone (no-
// releaseId) jobs, so its copy of the guards stays alive until the
// release-linked chain blocks are deleted entirely.

import type { JobData } from '@/lib/jobs/types';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';
import {
  fixContradictsReview,
  reviewIsStuck,
  type ReleaseConvergenceDeps,
} from '@/lib/workflows/guards/review-convergence';
import { checkIterationCap, type IterationCapDeps } from '@/lib/workflows/guards/iteration-caps';
import type { ReviewDoNotShipAction } from '@/lib/shared/config';

export interface ReviewDoNotShipPolicyDeps {
  /** getReviewDoNotShipAction() from `lib/pipeline/recovery-budget`. Controls
   *  whether a DO NOT SHIP verdict aborts the release, files a follow-up
   *  issue and continues to commit, or routes through the fix loop. */
  reviewDoNotShipAction: () => ReviewDoNotShipAction;
}

export type ApplyReleaseGuardsDeps = ReleaseConvergenceDeps &
  IterationCapDeps &
  ReviewDoNotShipPolicyDeps;

export interface ApplyReleaseGuardsInput {
  /** The just-finished sub-step that triggered this orchestrator tick. */
  job: JobData;
  /** decideNextPhase's verdict on what should run next. The guards may
   *  rewrite it. */
  decision: NextPhase;
  deps: ApplyReleaseGuardsDeps;
}

/** Run the convergence + cap guards over a NextPhase. Returns the original
 *  decision unchanged when no guard trips, or a rewritten decision (usually
 *  `next: 'abort'`) when the loop must be stopped.
 *
 *  Order of checks:
 *   1. fix-from-review convergence (reviewIsStuck, fixContradictsReview)
 *   2. iteration caps (review/test/commit/push retry budgets) */
export function applyReleaseGuards(input: ApplyReleaseGuardsInput): NextPhase {
  const { job, decision, deps } = input;

  // 0. DO NOT SHIP policy — applied first because decideNextPhase routes
  // DO NOT SHIP straight to abort, and the user-configurable policy may want
  // to (a) ship anyway with a follow-up issue (`pass`) or
  // (b) try the fix loop (`fix`) before deciding. `abort` (legacy) falls
  // through unchanged.
  if (
    decision.next === 'abort' &&
    decision.from === 'review' &&
    decision.verdict === 'DO NOT SHIP' &&
    job.kind === 'review'
  ) {
    const policy = deps.reviewDoNotShipAction();
    if (policy === 'pass') {
      return {
        next: 'commit',
        from: 'review',
        fileIssueForReviewId: job.id,
      };
    }
    if (policy === 'fix') {
      return { next: 'fix', from: 'review', verdict: 'DO NOT SHIP' };
    }
    // 'abort' → keep as-is, fall through.
  }

  // 1. Convergence guards — only relevant when the next step is a fix
  // triggered by a non-LGTM review verdict. Other "fix from X" decisions
  // don't have a convergence proxy yet (tests/commits/pushes can't easily
  // detect "same failure").
  if (decision.next === 'fix' && decision.from === 'review' && job.kind === 'review') {
    const contradiction = fixContradictsReview(job, deps);
    if (contradiction.stuck) {
      const ids = contradiction.ids.join(', ');
      return {
        next: 'abort',
        from: 'review',
        verdict: 'NEEDS ATTENTION',
        stopReason: `fix claimed ${ids} fixed but review still flags them — stopping`,
      };
    }
    if (reviewIsStuck(job, deps)) {
      return {
        next: 'abort',
        from: 'review',
        verdict: 'NEEDS ATTENTION',
        stopReason: `review findings unchanged from previous iteration for ${job.project} — fix not converging, stopping`,
      };
    }
  }

  // 2. Iteration caps — bound retry rounds for review/test/commit/push.
  // checkIterationCap returns a rewritten abort decision when a cap trips.
  const capCheck = checkIterationCap(job, decision, deps);
  if (capCheck.rewritten) return capCheck.rewritten;

  return decision;
}
