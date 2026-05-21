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
  /** Soak context. Only the soak phase consumes this; resolved from the
   *  release's pr-wait + project soak settings just before dispatch. */
  soak?: { mergeSha: string; prNumber: number; prRepo: string; prUrl: string; defaultBranch: string; watchMinutes: number; autoRevert: boolean };
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

  // Idempotency: after a PM2 restart, the workflow runtime resumes the
  // orchestrator from its checkpoint AND the completion-event router (or
  // any other resume path) can fire concurrently. Both then call
  // `start(release*PhaseWorkflow, ...)` and we end up with TWO push or
  // TWO fix jobs running side-by-side for the same release. If a child
  // step of the target kind is already in-flight for this release, skip
  // the dispatch — the existing run will progress the chain.
  if (ctx.parentJobId && await releaseHasInFlightChildOfKind(ctx.parentJobId, decision.next)) {
    return {
      dispatched: false,
      reason: 'dispatch_failed',
      phase: decision.next,
      error: `duplicate dispatch suppressed: in-flight ${decision.next} child already exists for release ${ctx.parentJobId}`,
    };
  }

  // Retry once on transient chunk-load errors. Next.js sometimes throws
  // `Failed to load chunk …` immediately after `pnpm rebuild` swaps the
  // `.next/` artifacts while an orchestrator tick is mid-dispatch — the
  // dynamic import resolves to a chunk path that was rewritten by the
  // new build. A short sleep + re-import picks up the new chunk and
  // succeeds; without this the release is silently aborted in the
  // middle of a healthy chain.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { start } = await import('workflow/api');
      let run;
    switch (decision.next) {
      case 'test': {
        // Plain-test phase: runs `pnpm test` directly (no Claude), much
        // cheaper for the happy path. Gated on the
        // `plain_test_phase_enabled` flag while the new path bakes.
        const { getSettings } = await import('@/lib/shared/config');
        if (getSettings().plain_test_phase_enabled) {
          const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
          run = await start(pnpmTestPhaseWorkflow, [ctx.projectName, ctx.parentJobId]);
        } else {
          const { releaseTestPhaseWorkflow } = await import('@/lib/workflows/phases/test-phase');
          run = await start(releaseTestPhaseWorkflow, [ctx.projectName, ctx.parentJobId]);
        }
        break;
      }
      case 'review': {
        const { releaseReviewPhaseWorkflow } = await import('@/lib/workflows/phases/review-phase');
        run = await start(releaseReviewPhaseWorkflow, [ctx.projectName, ctx.parentJobId]);
        break;
      }
      case 'fix': {
        // Exponential backoff between repeated fix-from-review iterations.
        // After the third review→fix transition, sleep before each new fix
        // dispatch so a long, slowly-converging loop doesn't burn tokens
        // and CI cycles at full speed. Setting `review_fix_backoff_seconds=0`
        // disables it entirely (default), matching the legacy behavior.
        if (decision.from === 'review' && ctx.parentJobId) {
          await sleepIfReviewBackoffStep(ctx.projectName, ctx.parentJobId);
        }
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
      case 'pr-wait': {
        const { releasePrWaitPhaseWorkflow } = await import('@/lib/workflows/phases/pr-wait-phase');
        run = await start(releasePrWaitPhaseWorkflow, [
          ctx.projectName,
          ctx.pr!.prNumber,
          ctx.pr!.prRepo,
          ctx.pr!.prUrl,
          ctx.parentJobId,
        ]);
        break;
      }
      case 'soak': {
        const { releaseSoakPhaseWorkflow } = await import('@/lib/workflows/phases/soak-phase');
        run = await start(releaseSoakPhaseWorkflow, [
          ctx.projectName,
          ctx.soak!,
          ctx.parentJobId,
        ]);
        break;
      }
    }
      if (!run) {
        // Type-narrowing should make this unreachable, but be defensive.
        return { dispatched: false, reason: 'dispatch_failed', phase: decision.next, error: 'no run handle' };
      }
      return { dispatched: true, phase: decision.next, childRunId: run.runId };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isChunkLoadError = /Failed to load chunk|Cannot find module|MODULE_NOT_FOUND/i.test(msg);
      if (isChunkLoadError && attempt === 1) {
        console.warn(`[dispatch-phase] chunk-load error on attempt ${attempt} for ${decision.next} (likely mid-rebuild): ${msg.slice(0, 200)} — retrying once`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return {
        dispatched: false,
        reason: 'dispatch_failed',
        phase: decision.next,
        error: msg,
      };
    }
  }
  return {
    dispatched: false,
    reason: 'dispatch_failed',
    phase: decision.next,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

/** Backoff threshold + cap. After this many prior review→fix iterations,
 *  start sleeping `base * 2^(n-threshold)` seconds before the next fix,
 *  capped at MAX_BACKOFF_SECONDS. Setting `review_fix_backoff_seconds=0`
 *  disables the gate entirely. */
const BACKOFF_THRESHOLD = 3;
const MAX_BACKOFF_SECONDS = 300;

export function computeFixBackoffSeconds(
  iterationCount: number,
  baseSeconds: number,
): number {
  if (baseSeconds <= 0) return 0;
  if (iterationCount <= BACKOFF_THRESHOLD) return 0;
  const exp = iterationCount - BACKOFF_THRESHOLD;
  // 2^exp grows quickly; clamp so a runaway loop doesn't sleep for hours.
  const seconds = baseSeconds * Math.pow(2, exp - 1);
  return Math.min(Math.floor(seconds), MAX_BACKOFF_SECONDS);
}

async function sleepIfReviewBackoffStep(
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  const { getSettings } = await import('@/lib/shared/config');
  const base = getSettings().review_fix_backoff_seconds;
  if (base <= 0) return;
  const { listJobs } = await import('@/lib/jobs/job-storage');
  // Count completed fix-from-review iterations: every existing `review`
  // sibling step in this release represents one prior cycle.
  let iterations = 0;
  for (const j of listJobs()) {
    if (j.releaseId === releaseJobId && j.kind === 'review' && j.finishedAt !== null) iterations++;
  }
  const sleep = computeFixBackoffSeconds(iterations, base);
  if (sleep <= 0) return;
  console.log(`[dispatch-phase] backoff: sleeping ${sleep}s before fix dispatch (iteration ${iterations}, project ${projectName})`);
  await new Promise<void>((resolve) => setTimeout(resolve, sleep * 1000).unref?.());
}

/** Map the next-phase decision kind to the job-row kind that a previous
 *  dispatch would have created. Used by the idempotency check below. */
function jobKindForNextPhase(phase: NextPhase['next']): string | null {
  switch (phase) {
    case 'test': return 'test';
    case 'review': return 'review';
    case 'fix': return 'fix';
    case 'commit': return 'commit';
    case 'push': return 'push';
    case 'mark-dod': return 'mark-dod';
    case 'pr-wait': return 'pr-wait';
    case 'soak': return 'soak';
    default: return null;
  }
}

async function releaseHasInFlightChildOfKind(
  releaseJobId: string,
  phase: NextPhase['next'],
): Promise<boolean> {
  const kind = jobKindForNextPhase(phase);
  if (!kind) return false;
  try {
    const { listJobs } = await import('@/lib/jobs/job-storage');
    return listJobs().some(j =>
      j.releaseId === releaseJobId &&
      j.kind === kind &&
      j.finishedAt === null,
    );
  } catch {
    // listJobs unavailable in unusual contexts — fail open (allow
    // dispatch). The duplicate is preferable to a stranded release.
    return false;
  }
}

function requiredContextMissing(phase: NextPhase['next'], ctx: DispatchContext): string[] {
  const missing: string[] = [];
  if (!ctx.projectName) missing.push('projectName');
  if (phase === 'fix' && !ctx.prevJobId) missing.push('prevJobId');
  if (phase === 'pr-wait') {
    if (!ctx.pr?.prNumber) missing.push('pr.prNumber');
    if (!ctx.pr?.prRepo) missing.push('pr.prRepo');
    if (!ctx.pr?.prUrl) missing.push('pr.prUrl');
  }
  if (phase === 'soak') {
    if (!ctx.soak?.prNumber) missing.push('soak.prNumber');
    if (!ctx.soak?.prRepo) missing.push('soak.prRepo');
    if (!ctx.soak?.prUrl) missing.push('soak.prUrl');
    if (!ctx.soak?.mergeSha) missing.push('soak.mergeSha');
    if (!ctx.soak?.defaultBranch) missing.push('soak.defaultBranch');
    if (!ctx.soak?.watchMinutes || ctx.soak.watchMinutes <= 0) missing.push('soak.watchMinutes');
  }
  // test, review, commit, push, mark-dod only need projectName.
  return missing;
}
