// Second per-phase workflow. Same shape as test-phase: kickoff →
// await → return. Difference: the result also carries the parsed verdict
// (LGTM / NEEDS ATTENTION / DO NOT SHIP / null) so the orchestrator can
// branch without re-parsing the log.
//
// Dispatched by releaseOrchestratorWorkflow via dispatchPhase. The workflow
// re-dispatches the orchestrator when its review sub-step finishes so the
// release chain continues through workflow runs instead of the legacy
// completion-hook chain.

import type { StartReviewResult } from '@/lib/pipeline/start-review';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';
import { safeStartOrchestrator } from '@/lib/workflows/safe-start-orchestrator';
import { resolveAttachableInflightStep } from '@/lib/workflows/phases/attach-inflight';

export type ReviewVerdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP' | null;

export type ReviewPhaseResult =
  | {
      ok: true;
      jobId: string;
      finished: boolean;
      reason: WaitForJobResult['reason'];
      exitCode: number | null;
      verdict: ReviewVerdict;
      summary: string | null;
    }
  | {
      ok: false;
      reason: 'start_failed';
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releaseReviewPhaseWorkflow(
  projectName: string,
  releaseJobId?: string,
): Promise<ReviewPhaseResult> {
  'use workflow';
  const started = await spawnReviewStep(projectName, releaseJobId);
  let reviewJobId: string;
  if (started.ok) {
    reviewJobId = started.jobId;
  } else {
    // A 409 "Review already in progress" is a transient concurrency
    // condition, not a real failure — e.g. a boot-recovery re-drive of this
    // release (after a TamTam restart mid-pipeline) racing the review that
    // was already running. If the blocker is itself a review of THIS
    // project, attach to it and continue the release from its result instead
    // of aborting: the in-flight review covers the same working tree, so its
    // verdict is exactly what this phase needs.
    const attachJobId = started.status === 409 && started.blockingJobId
      ? await resolveAttachableInflightStep(started.blockingJobId, projectName, 'review')
      : null;
    if (attachJobId) {
      reviewJobId = attachJobId;
    } else {
      // Prereq-command failure (or any other startProjectReview failure)
      // returns before a review job row exists. Without finalizing the
      // release here, the meta-job stays in `running` with no in-flight
      // child until the wall-clock timeout 90 min later. Drive the release
      // to a terminal state immediately so the trace explains the failure.
      if (releaseJobId) {
        const detail = `review startup failed: ${started.detail}`;
        await finalizeReleaseOnReviewStartFailureStep(releaseJobId, detail);
      }
      return {
        ok: false,
        reason: 'start_failed',
        status: started.status,
        detail: started.detail,
        ...(started.blockingJobId ? { blockingJobId: started.blockingJobId } : {}),
      };
    }
  }
  const waited = await awaitReviewCompletionStep(reviewJobId);
  const verdict = waited.finished ? await readReviewVerdictStep(reviewJobId) : null;
  const summary = waited.finished ? await readReviewSummaryStep(reviewJobId) : null;
  // Close the loop: re-dispatch the orchestrator for this sub-step so the
  // chain continues fully through workflow runs. Without this the legacy
  // reconciler's hook re-fire is the only thing that moves the chain past
  // review, and the release meta-job ends up finalized as exit=-1 by the
  // reconciler instead of by the workflow runtime.
  if (waited.finished && releaseJobId) {
    await dispatchOrchestratorTickStep(reviewJobId, projectName, releaseJobId);
  }
  return {
    ok: true,
    jobId: reviewJobId,
    finished: waited.finished,
    reason: waited.reason,
    exitCode: waited.job?.exitCode ?? null,
    verdict,
    summary,
  };
}

async function spawnReviewStep(
  projectName: string,
  releaseJobId?: string,
): Promise<StartReviewResult> {
  'use step';
  const { startProjectReview } = await import('@/lib/pipeline/start-review');
  // Wrap in parentContext so the spawned review job inherits release linkage.
  // Without this, createJob() reads currentParent() as null inside the workflow
  // runtime (AsyncLocalStorage doesn't carry across step boundaries) and the
  // review row ends up with parent_job_id=NULL, release_id=NULL — the
  // lifecycle short-circuit gates on releaseId, so a missing linkage lets
  // the legacy chain double-dispatch alongside the orchestrator.
  if (!releaseJobId) return startProjectReview(projectName);
  const { runWithParent } = await import('@/lib/jobs/parent-context');
  return runWithParent(releaseJobId, () => startProjectReview(projectName));
}

async function awaitReviewCompletionStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}

async function readReviewVerdictStep(jobId: string): Promise<ReviewVerdict> {
  'use step';
  const { getJob, getVerdict } = await import('@/lib/jobs/job-storage');
  const job = getJob(jobId);
  if (!job) return null;
  const v = getVerdict(job);
  if (v === 'LGTM' || v === 'NEEDS ATTENTION' || v === 'DO NOT SHIP') return v;
  return null;
}

async function readReviewSummaryStep(jobId: string): Promise<string | null> {
  'use step';
  const { getJob } = await import('@/lib/jobs/job-storage');
  const job = getJob(jobId);
  const summary = job?.workSummary?.trim();
  return summary && summary.length > 0 ? summary : null;
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'review-phase');
}

async function finalizeReleaseOnReviewStartFailureStep(
  releaseJobId: string,
  detail: string,
): Promise<void> {
  'use step';
  const { getJob, updateJob, markDone } = await import('@/lib/jobs/job-storage');
  const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
  const release = getJob(releaseJobId);
  if (!release || release.kind !== 'release' || release.finishedAt !== null) return;
  // Persist the stop reason on the release row so the trace UI shows
  // why the orchestrator gave up before commit/push.
  try {
    const meta = release.contextMeta ? JSON.parse(release.contextMeta) : {};
    const merged = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : {};
    merged.releaseStopReason = detail;
    release.contextMeta = JSON.stringify(merged);
    updateJob(release);
  } catch { /* best-effort — markDone still finalizes */ }
  if (release.logPath) {
    try { appendRedactedFileSync(release.logPath, `\n# release aborted before review: ${detail}\n`); } catch {}
  }
  try { await markDone(release, 1); } catch (err) {
    console.error(`[review-phase] failed to finalize release ${releaseJobId} after review startup failure:`, err);
  }
}
