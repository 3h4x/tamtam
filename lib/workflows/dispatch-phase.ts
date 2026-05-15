// Connective tissue between decideNextPhase and the 8 per-phase workflows.
//
// Given a NextPhase decision and a DispatchContext, calls
// start(release*PhaseWorkflow, [args]) for the matching phase. Returns the
// child workflow's runId (for traceability into workflow_runs) or null for
// terminal decisions (done / abort / unknown — no phase to dispatch).
//
// This is the seam that lets the future state-machine workflow body
// replace the current polling observation chain with direct dispatch:
//
//   const decision = await decideNextPhase(...)
//   const childRunId = await dispatchPhase(decision, ctx)
//   if (childRunId) {
//     // child runs independently; orchestrator returns
//   }
//
// Dispatch failures (missing context, runtime error) are surfaced as the
// 'dispatch_failed' branch rather than thrown, so the orchestrator can
// log and continue without crashing the parent workflow.

import type { NextPhase } from '@/lib/workflows/decide-next-phase';
import type { MarkDodOverride } from '@/lib/workflows/phases/mark-dod-phase';

export interface DispatchContext {
  /** Always required — every phase needs the project. */
  projectName: string;
  /** Only the just-finished sub-step's jobId. fix-phase needs this. */
  prevJobId?: string;
  /** PR identity. pr-wait needs all three. */
  pr?: { prNumber: number; prRepo: string; prUrl: string };
  /** Targeting override for mark-dod (issueNumber / prNumber / repo). */
  dodOverride?: MarkDodOverride;
  /** Forwarded to push/commit phases for chain tracking. */
  parentJobId?: string;
}

export type DispatchPhaseOutcome =
  | { dispatched: true; phase: NextPhase['next']; childRunId: string }
  | { dispatched: false; reason: 'terminal'; phase: 'done' | 'abort' | 'unknown' }
  | { dispatched: false; reason: 'missing_context'; phase: NextPhase['next']; missing: string[] }
  | { dispatched: false; reason: 'dispatch_failed'; phase: NextPhase['next']; error: string };

export async function dispatchPhase(
  decision: NextPhase,
  ctx: DispatchContext,
): Promise<DispatchPhaseOutcome> {
  // Terminal decisions don't dispatch anything.
  if (decision.next === 'done' || decision.next === 'abort' || decision.next === 'unknown') {
    return { dispatched: false, reason: 'terminal', phase: decision.next };
  }

  // Check context requirements before importing workflow/api — avoids a
  // pointless `start()` call if we know it'll fail.
  const missing = requiredContextMissing(decision.next, ctx);
  if (missing.length > 0) {
    return { dispatched: false, reason: 'missing_context', phase: decision.next, missing };
  }

  try {
    const { start } = await import('workflow/api');
    let run;
    switch (decision.next) {
      case 'test': {
        const { releaseTestPhaseWorkflow } = await import('@/lib/workflows/phases/test-phase');
        run = await start(releaseTestPhaseWorkflow, [ctx.projectName, ctx.parentJobId]);
        break;
      }
      case 'review': {
        const { releaseReviewPhaseWorkflow } = await import('@/lib/workflows/phases/review-phase');
        run = await start(releaseReviewPhaseWorkflow, [ctx.projectName, ctx.parentJobId]);
        break;
      }
      case 'fix': {
        const { releaseFixPhaseWorkflow } = await import('@/lib/workflows/phases/fix-phase');
        run = await start(releaseFixPhaseWorkflow, [ctx.prevJobId!, ctx.projectName, ctx.parentJobId]);
        break;
      }
      case 'commit': {
        const { releaseCommitPhaseWorkflow } = await import('@/lib/workflows/phases/commit-phase');
        run = await start(releaseCommitPhaseWorkflow, [ctx.projectName, { parentJobId: ctx.parentJobId ?? null }, ctx.parentJobId]);
        break;
      }
      case 'push': {
        const { releasePushPhaseWorkflow } = await import('@/lib/workflows/phases/push-phase');
        run = await start(releasePushPhaseWorkflow, [ctx.projectName, { parentJobId: ctx.parentJobId ?? null }, ctx.parentJobId]);
        break;
      }
      case 'mark-dod': {
        const { releaseMarkDodPhaseWorkflow } = await import('@/lib/workflows/phases/mark-dod-phase');
        run = await start(releaseMarkDodPhaseWorkflow, [ctx.projectName, ctx.dodOverride, ctx.parentJobId]);
        break;
      }
    }
    if (!run) {
      // Type-narrowing should make this unreachable, but be defensive.
      return { dispatched: false, reason: 'dispatch_failed', phase: decision.next, error: 'no run handle' };
    }
    return { dispatched: true, phase: decision.next, childRunId: run.runId };
  } catch (err) {
    return {
      dispatched: false,
      reason: 'dispatch_failed',
      phase: decision.next,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function requiredContextMissing(phase: NextPhase['next'], ctx: DispatchContext): string[] {
  const missing: string[] = [];
  if (!ctx.projectName) missing.push('projectName');
  if (phase === 'fix' && !ctx.prevJobId) missing.push('prevJobId');
  // test, review, commit, push, mark-dod only need projectName.
  // 'pr-wait' is invoked directly by push-phase, not via NextPhase.
  return missing;
}
