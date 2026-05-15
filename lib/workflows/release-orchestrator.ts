// The state machine.
//
// `releaseOrchestratorWorkflow` takes a sub-step jobId, waits for it to
// finish, decides the next phase, and dispatches the matching phase
// workflow — which itself is a child workflow that runs independently and,
// when finished, can dispatch the next orchestrator tick for ITS sub-step
// jobId. The chain self-perpetuates, but instead of POLLING for the next
// sibling job that completion hooks spawned, it DRIVES the next phase
// directly.
//
// Always active for releases. The completion-hook chain in
// lib/jobs/lifecycle.ts short-circuits on `releaseId` for any release-
// linked pipeline step, so the orchestrator owns dispatch alone (no
// double-dispatch). The `workflowDriven` contextMeta flag this used to
// rely on was retired — gating on linkage is robust by construction.

import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';
import type { DispatchContext, DispatchPhaseOutcome } from '@/lib/workflows/dispatch-phase';

export interface OrchestratorTickResult {
  waited: WaitForJobResult;
  decision: NextPhase | null;
  dispatch: DispatchPhaseOutcome | null;
}

export async function releaseOrchestratorWorkflow(
  jobId: string,
  ctx: DispatchContext,
): Promise<OrchestratorTickResult> {
  'use workflow';
  const waited = await waitStep(jobId);
  if (!waited.finished || !waited.job) return { waited, decision: null, dispatch: null };
  const decision = await decideStep(waited.job.id);
  // When the guard rewrote a DO NOT SHIP / NEEDS ATTENTION abort into a
  // "ship anyway with follow-up issue" decision, file the GitHub issue with
  // the persistent review findings before dispatching commit. Best-effort:
  // commit still runs if the issue can't be filed (offline gh, permissions,
  // etc.). Logged so operators can see what happened.
  if (decision.next === 'commit' && decision.fileIssueForReviewId) {
    await fileReviewExhaustionIssueStep(
      decision.fileIssueForReviewId,
      ctx.parentJobId ?? null,
    );
  }
  const dispatch = await dispatchStep(decision, { ...ctx, prevJobId: waited.job.id });
  // When the chain reaches a terminal decision (done / abort / unknown),
  // finalize the release meta-job so its row in /runs reflects the actual
  // outcome instead of staying open until the legacy reconciler reaps it.
  if (
    dispatch.dispatched === false &&
    dispatch.reason === 'terminal' &&
    ctx.parentJobId
  ) {
    // Stash the guard's stop reason on the release before finalizing so the
    // UI / pipeline trace surfaces the abort cause. When the abort came
    // from a review-side guard with a NEEDS ATTENTION verdict (not DO NOT
    // SHIP), file the exhaustion-fallback GitHub issue with the persistent
    // findings so the user has a follow-up artifact.
    const stopReason = decision.next === 'abort' && 'stopReason' in decision
      ? decision.stopReason
      : undefined;
    const fileExhaustionIssueForReviewId =
      decision.next === 'abort' &&
      decision.from === 'review' &&
      decision.verdict === 'NEEDS ATTENTION' &&
      waited.job.kind === 'review'
        ? waited.job.id
        : undefined;
    await finalizeReleaseStep(
      ctx.parentJobId,
      dispatch.phase,
      waited.job.exitCode ?? 0,
      stopReason,
      fileExhaustionIssueForReviewId,
    );
  }
  return { waited, decision, dispatch };
}

async function waitStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}

async function decideStep(jobId: string): Promise<NextPhase> {
  'use step';
  const { getJob, getVerdict, listJobs, readParsedLog } = await import('@/lib/jobs/job-storage');
  const { decideNextPhase } = await import('@/lib/workflows/decide-next-phase');
  const { applyReleaseGuards } = await import('@/lib/workflows/guards/apply-release-guards');
  const {
    getMaxStepIterations,
    getReviewFixMaxIterations,
    getPushFixAttemptCap,
    getReviewDoNotShipAction,
  } = await import('@/lib/pipeline/recovery-budget');
  const job = getJob(jobId);
  if (!job) return { next: 'unknown', from: 'unknown', reason: `job ${jobId} not found in cache` };
  const verdict = job.kind === 'review' ? getVerdict(job) : null;
  // Fix completions need the parent's kind to route back to re-verification.
  // Non-fix kinds ignore parentKind so this is harmless when not relevant.
  const parent = job.parentJobId ? getJob(job.parentJobId) : null;
  const parentKind = parent?.kind ?? null;
  const decision = decideNextPhase({ kind: job.kind, exitCode: job.exitCode ?? -1, verdict, parentKind });
  // Pre-dispatch guards: convert `{ next: 'fix' }` into `{ next: 'abort' }`
  // when the fix loop would not converge (reviewIsStuck/fixContradictsReview),
  // or when an iteration cap (review/test/commit/push) is exhausted.
  return applyReleaseGuards({
    job,
    decision,
    deps: {
      listJobs,
      readParsedLog,
      maxStepIterations: getMaxStepIterations,
      reviewFixMaxIterations: getReviewFixMaxIterations,
      pushFixAttemptCap: getPushFixAttemptCap,
      reviewDoNotShipAction: getReviewDoNotShipAction,
    },
  });
}

async function dispatchStep(
  decision: NextPhase,
  ctx: DispatchContext,
): Promise<DispatchPhaseOutcome> {
  'use step';
  const { dispatchPhase } = await import('@/lib/workflows/dispatch-phase');
  return dispatchPhase(decision, ctx);
}

async function fileReviewExhaustionIssueStep(
  reviewJobId: string,
  releaseJobId: string | null,
): Promise<void> {
  'use step';
  try {
    const { getJob } = await import('@/lib/jobs/job-storage');
    const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const reviewJob = getJob(reviewJobId);
    if (!reviewJob) return;
    const r = await fileReviewExhaustionIssue(reviewJob);
    const release = releaseJobId ? getJob(releaseJobId) : null;
    if (r.ok) {
      console.log(`[release] DO NOT SHIP → follow-up issue filed: ${r.issueUrl}; continuing to commit`);
      if (release?.logPath) {
        try {
          appendRedactedFileSync(release.logPath, `# review do-not-ship → follow-up issue: ${r.issueUrl}\n`);
        } catch {}
      }
    } else {
      console.warn(`[release] DO NOT SHIP → failed to file follow-up issue: ${r.error}`);
      if (release?.logPath) {
        try {
          appendRedactedFileSync(
            release.logPath,
            `# review do-not-ship → follow-up issue failed: ${r.error}\n`,
          );
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[release] do-not-ship issue side effect threw:', e);
  }
}

async function finalizeReleaseStep(
  releaseJobId: string,
  terminalPhase: 'done' | 'abort' | 'unknown',
  lastStepExitCode: number,
  stopReason?: string,
  fileExhaustionIssueForReviewId?: string,
): Promise<void> {
  'use step';
  const { getJob, updateJob } = await import('@/lib/jobs/job-storage');
  const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
  const { finalizeReleaseJob, finalizeAbortedRelease } = await import('@/lib/jobs/lifecycle');
  const release = getJob(releaseJobId);
  if (!release || release.kind !== 'release' || release.finishedAt !== null) return;
  // Persist the guard-supplied stop reason on the release row + log so the
  // pipeline trace UI explains why the orchestrator aborted instead of just
  // showing exit -3 with no explanation.
  if (stopReason) {
    try {
      const meta = release.contextMeta ? JSON.parse(release.contextMeta) : {};
      const merged = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : {};
      merged.releaseStopReason = stopReason;
      release.contextMeta = JSON.stringify(merged);
      updateJob(release);
    } catch {}
    if (release.logPath) {
      try { appendRedactedFileSync(release.logPath, `\n# release stopped — ${stopReason}\n`); } catch {}
    }
  }
  // Exhaustion fallback: when the orchestrator aborts because the review-side
  // guard exhausted (cap, stuck, contradiction) and the verdict was NEEDS
  // ATTENTION (not DO NOT SHIP), file a GitHub issue with the persistent
  // findings so the user has a concrete follow-up artifact instead of just
  // a red release row. Best-effort: log + continue on failure.
  if (fileExhaustionIssueForReviewId) {
    try {
      const reviewJob = getJob(fileExhaustionIssueForReviewId);
      if (reviewJob) {
        const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
        const r = await fileReviewExhaustionIssue(reviewJob);
        if (r.ok) {
          console.log(`[release] exhaustion issue filed: ${r.issueUrl}`);
          if (release.logPath) {
            try { appendRedactedFileSync(release.logPath, `# exhaustion issue: ${r.issueUrl}\n`); } catch {}
          }
        } else {
          console.warn(`[release] failed to file exhaustion issue: ${r.error}`);
        }
      }
    } catch (e) {
      console.warn('[release] exhaustion-issue side effect threw:', e);
    }
  }
  if (terminalPhase === 'abort') {
    await finalizeAbortedRelease(release);
    return;
  }
  // 'done' or 'unknown' — use the last step's exit code as the release outcome.
  // 'unknown' falls through too: if the orchestrator can't classify the last
  // step (e.g. a release meta-job hitting the orchestrator directly), the
  // safest outcome is to mirror its exit code rather than leave the row open.
  await finalizeReleaseJob(release, lastStepExitCode);
}
