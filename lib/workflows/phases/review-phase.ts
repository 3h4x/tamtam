// Second per-phase workflow. Same shape as test-phase: kickoff →
// await → return. Difference: the result also carries the parsed verdict
// (LGTM / NEEDS ATTENTION / DO NOT SHIP / null) so the future orchestrator
// can branch without re-parsing the log.
//
// Future iterations replace the observation chain's polling with direct
// dispatch of releaseReviewPhaseWorkflow. Until then, this workflow is
// scaffold — not yet wired from anywhere.

import type { StartReviewResult } from '@/lib/pipeline/start-review';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';

export type ReviewVerdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP' | null;

export type ReviewPhaseResult =
  | {
      ok: true;
      jobId: string;
      finished: boolean;
      reason: WaitForJobResult['reason'];
      exitCode: number | null;
      verdict: ReviewVerdict;
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
  if (!started.ok) {
    return {
      ok: false,
      reason: 'start_failed',
      status: started.status,
      detail: started.detail,
      ...(started.blockingJobId ? { blockingJobId: started.blockingJobId } : {}),
    };
  }
  const waited = await awaitReviewCompletionStep(started.jobId);
  const verdict = waited.finished ? await readReviewVerdictStep(started.jobId) : null;
  // Close the loop: re-dispatch the orchestrator for this sub-step so the
  // chain continues fully through workflow runs. Without this the legacy
  // reconciler's hook re-fire is the only thing that moves the chain past
  // review, and the release meta-job ends up finalized as exit=-1 by the
  // reconciler instead of by the workflow runtime.
  if (waited.finished && releaseJobId) {
    await dispatchOrchestratorTickStep(started.jobId, projectName, releaseJobId);
  }
  return {
    ok: true,
    jobId: started.jobId,
    finished: waited.finished,
    reason: waited.reason,
    exitCode: waited.job?.exitCode ?? null,
    verdict,
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
  // review row ends up with parent_job_id=NULL, release_id=NULL — which then
  // causes isWorkflowDriven() to return false and the legacy lifecycle hook
  // double-dispatches the next step.
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

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  try {
    const { start } = await import('workflow/api');
    const { releaseOrchestratorWorkflow } = await import('@/lib/workflows/release-orchestrator');
    await start(releaseOrchestratorWorkflow, [jobId, { projectName, parentJobId: releaseJobId }]);
  } catch (err) {
    console.error('[review-phase] failed to re-dispatch orchestrator:', err);
  }
}
