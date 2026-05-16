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
  // Propagate PR context to the dispatcher when the decision is to launch
  // pr-wait. Without this, dispatchPhase's required-context check rejects.
  const dispatchCtx: DispatchContext = { ...ctx, prevJobId: waited.job.id };
  if (decision.next === 'pr-wait') {
    dispatchCtx.pr = decision.pr;
  }
  const dispatch = await dispatchStep(decision, dispatchCtx);
  // Finalize the release meta-job whenever this tick did not start a child
  // workflow — otherwise the release sits in `running` until the wall-clock
  // sweep reaps it. Three cases:
  //   - `terminal`           — decideStep / guards routed to done/abort/unknown.
  //   - `dispatch_failed`    — `start(child)` threw (workflow runtime gap,
  //                            transient queue error, etc.). The chain is
  //                            broken; fail loudly with the underlying error.
  //   - `missing_context`    — the dispatch needed a value (e.g. prevJobId)
  //                            that the caller didn't pass. Programmer error;
  //                            finalize and surface so it doesn't silently
  //                            hang the release.
  if (dispatch.dispatched === false && ctx.parentJobId) {
    // Stash the guard's stop reason on the release before finalizing so the
    // UI / pipeline trace surfaces the abort cause. When the abort came
    // from a review-side guard with a NEEDS ATTENTION verdict (not DO NOT
    // SHIP), file the exhaustion-fallback GitHub issue with the persistent
    // findings so the user has a follow-up artifact.
    const stopReason = computeStopReason(dispatch, decision);
    const fileExhaustionIssueForReviewId =
      decision.next === 'abort' &&
      decision.from === 'review' &&
      decision.verdict === 'NEEDS ATTENTION' &&
      waited.job.kind === 'review'
        ? waited.job.id
        : undefined;
    // For terminal decisions, the release outcome mirrors the last step's
    // exit code. For dispatch failures, we have no successful chain to point
    // at — propagate exit 1 so the release row goes red rather than
    // inheriting an exit-0 from a successful prior step.
    const lastExitCode =
      dispatch.reason === 'terminal'
        ? waited.job.exitCode ?? 0
        : 1;
    // `dispatch.phase` is the next phase that would have run for
    // dispatch_failed/missing_context, not a real terminal phase. Coerce to
    // 'abort' so finalizeReleaseStep takes the aborted-release path.
    const terminalPhase: 'done' | 'abort' | 'unknown' =
      dispatch.reason === 'terminal'
        ? dispatch.phase
        : 'abort';
    await finalizeReleaseStep(
      ctx.parentJobId,
      terminalPhase,
      lastExitCode,
      stopReason,
      fileExhaustionIssueForReviewId,
    );
  }
  return { waited, decision, dispatch };
}

function computeStopReason(
  dispatch: DispatchPhaseOutcome,
  decision: NextPhase,
): string | undefined {
  if (dispatch.dispatched !== false) return undefined;
  if (dispatch.reason === 'terminal') {
    return decision.next === 'abort' && 'stopReason' in decision
      ? decision.stopReason
      : undefined;
  }
  if (dispatch.reason === 'dispatch_failed') {
    return `failed to dispatch ${dispatch.phase} phase: ${dispatch.error}`;
  }
  if (dispatch.reason === 'missing_context') {
    return `missing context for ${dispatch.phase} dispatch: ${dispatch.missing.join(', ')}`;
  }
  return undefined;
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
  // For mark-dod → pr-wait routing under auto-merge: look up the release's
  // most recent push job and inspect its contextMeta for PR identity, then
  // read the project's auto_pr_merge_enabled flag. Cheap (cached) on the
  // happy path because we only do this when kind === 'mark-dod'.
  let pushPrContext: { prNumber: number; prRepo: string; prUrl: string } | null = null;
  let autoPrMergeEnabled = false;
  if (job.kind === 'mark-dod' && job.releaseId) {
    const pushJob = listJobs()
      .filter((j) => j.releaseId === job.releaseId && j.kind === 'push' && j.exitCode === 0)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (pushJob?.contextMeta) {
      try {
        const meta = JSON.parse(pushJob.contextMeta) as { prUrl?: string; prNumber?: number; prRepo?: string };
        if (meta.prUrl && meta.prNumber && meta.prRepo) {
          pushPrContext = { prUrl: meta.prUrl, prNumber: meta.prNumber, prRepo: meta.prRepo };
        }
      } catch {}
    }
    if (pushPrContext) {
      try {
        const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
        const cfg = await getProjectTestConfig(job.project);
        autoPrMergeEnabled = !!cfg?.autoPrMergeEnabled;
      } catch {}
    }
  }
  const decision = decideNextPhase({
    kind: job.kind,
    exitCode: job.exitCode ?? -1,
    verdict,
    parentKind,
    pushPrContext,
    autoPrMergeEnabled,
  });
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
