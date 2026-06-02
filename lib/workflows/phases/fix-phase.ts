// Third per-phase workflow scaffold: fix. Slightly different shape from
// test/review — fix runs in the context of an earlier job that needs
// remediation: a failed test/commit/push, or a review that returned
// NEEDS ATTENTION or DO NOT SHIP. The existing startFixFromJob helper
// takes a sourceJobId pointing at that parent.
//
// Dispatched by releaseOrchestratorWorkflow via dispatchPhase when the
// orchestrator decides { next: 'fix', from: 'test' | 'review' | 'commit' | 'push' }.

import type { StartFixResult } from '@/lib/pipeline/start-fix';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';
import { safeStartOrchestrator } from '@/lib/workflows/safe-start-orchestrator';
import { resolveAttachableInflightStep } from '@/lib/workflows/phases/attach-inflight';

export type FixPhaseResult =
  | {
      ok: true;
      jobId: string;
      sourceJobId: string;
      finished: boolean;
      reason: WaitForJobResult['reason'];
      exitCode: number | null;
    }
  | {
      ok: false;
      reason: 'start_failed';
      sourceJobId: string;
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releaseFixPhaseWorkflow(
  sourceJobId: string,
  projectName?: string,
  releaseJobId?: string,
): Promise<FixPhaseResult> {
  'use workflow';
  const started = await spawnFixStep(sourceJobId, releaseJobId);
  let fixJobId: string;
  if (started.ok) {
    fixJobId = started.jobId;
  } else {
    // A 409 means a fix for this release is already in flight (lost the atomic
    // start claim, e.g. two racing review sources under one release). Attach
    // to it and continue instead of aborting the release.
    const attach = started.status === 409 && projectName
      ? await resolveAttachableInflightStep(started.blockingJobId, projectName, 'fix')
      : null;
    if (!attach) {
      return {
        ok: false,
        reason: 'start_failed',
        sourceJobId,
        status: started.status,
        detail: started.detail,
        ...(started.blockingJobId ? { blockingJobId: started.blockingJobId } : {}),
      };
    }
    fixJobId = attach;
  }
  const waited = await awaitFixCompletionStep(fixJobId);
  // Re-dispatch the orchestrator so the chain progresses through workflow
  // runs (typically fix → test for another verification round).
  if (waited.finished && projectName && releaseJobId) {
    await dispatchOrchestratorTickStep(fixJobId, projectName, releaseJobId);
  }
  return {
    ok: true,
    jobId: fixJobId,
    sourceJobId,
    finished: waited.finished,
    reason: waited.reason,
    exitCode: waited.job?.exitCode ?? null,
  };
}

async function spawnFixStep(
  sourceJobId: string,
  releaseJobId?: string,
): Promise<StartFixResult> {
  'use step';
  const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
  // See review-phase.ts. start-fix already passes sourceJobId as parentJobId,
  // but the release_id derivation in createJob walks parent.releaseId — so
  // we still need the release in scope so a fix dispatched without a chain
  // ancestor (cold restart) inherits it from the release meta-job.
  if (!releaseJobId) return startFixFromJob(sourceJobId);
  const { runWithParent } = await import('@/lib/jobs/parent-context');
  return runWithParent(releaseJobId, () => startFixFromJob(sourceJobId));
}

async function awaitFixCompletionStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'fix-phase');
}
