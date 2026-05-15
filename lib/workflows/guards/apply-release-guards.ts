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
//     (recentStepCount + maxStepIterations) — TODO: separate task
//   - Should we file a GitHub exhaustion issue instead of silently aborting?
//     (tryReviewExhaustionFallback)                                  — TODO
//
// When a guard trips, the dispatch decision is rewritten to
// `{ next: 'abort', stopReason }`. The orchestrator's terminal-decision
// branch picks that up, persists the stop reason on the release meta-job,
// and finalizes the release as failed.
//
// The guards lift the equivalent logic out of `lib/jobs/lifecycle.ts`'s
// completion-hook chain. The legacy hook still runs for standalone (no-
// releaseId) jobs and for the `TAMTAM_RELEASE_WORKFLOW_DRIVE=0` opt-out
// fallback, so its copy of the guards stays alive until the chain blocks
// are deleted entirely.

import type { JobData } from '@/lib/jobs/types';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';
import {
  fixContradictsReview,
  reviewIsStuck,
  type ReleaseConvergenceDeps,
} from '@/lib/workflows/guards/review-convergence';
import { checkIterationCap, type IterationCapDeps } from '@/lib/workflows/guards/iteration-caps';

export type ApplyReleaseGuardsDeps = ReleaseConvergenceDeps & IterationCapDeps;

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

  // 1. Convergence guards — only relevant when the next step is a fix
  // triggered by a NEEDS ATTENTION review. DO NOT SHIP already aborts in
  // decideNextPhase. Other "fix from X" decisions don't have a convergence
  // proxy yet (tests/commits/pushes can't easily detect "same failure").
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
