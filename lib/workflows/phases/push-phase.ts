// Fourth per-phase workflow scaffold: push. Different shape from
// test/review/fix because push runs **inline** in the server process (not
// spawned as a background job) — startProjectPush returns synchronously
// with the commit SHA and optional PR info. So the phase workflow needs
// just one step.
//
// Future iterations dispatch this when the orchestrator decides
// { next: 'push' } from a review-LGTM or fresh-LGTM branch. Not wired
// yet.

import type { PushResult } from '@/lib/pipeline/start-push';

export type PushPhaseResult =
  | {
      ok: true;
      commitSha: string;
      message: string;
      prUrl?: string;
      prNumber?: number;
      prRepo?: string;
    }
  | {
      ok: false;
      reason: 'push_failed';
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releasePushPhaseWorkflow(
  projectName: string,
  options: { parentJobId?: string | null } = {},
  releaseJobId?: string,
): Promise<PushPhaseResult> {
  'use workflow';
  const r = await pushStep(projectName, options, releaseJobId);
  if (!r.ok) {
    if (releaseJobId && r.jobId) {
      await dispatchOrchestratorTickStep(r.jobId, projectName, releaseJobId);
    }
    return {
      ok: false,
      reason: 'push_failed',
      status: r.status,
      detail: r.detail,
      ...(r.blockingJobId ? { blockingJobId: r.blockingJobId } : {}),
    };
  }
  // Re-dispatch orchestrator so the chain continues into mark-dod (or back
  // to fix if the hook rejected the push). Without this, the release
  // meta-job would stay running because push is the chain's transition
  // point into the post-push branch.
  if (releaseJobId && r.jobId) {
    await dispatchOrchestratorTickStep(r.jobId, projectName, releaseJobId);
  }
  return {
    ok: true,
    commitSha: r.commitSha,
    message: r.message,
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    ...(r.prNumber != null ? { prNumber: r.prNumber } : {}),
    ...(r.prRepo ? { prRepo: r.prRepo } : {}),
  };
}

async function pushStep(
  projectName: string,
  options: { parentJobId?: string | null },
  releaseJobId?: string,
): Promise<PushResult> {
  'use step';
  const { startProjectPush } = await import('@/lib/pipeline/start-push');
  // See review-phase.ts: wrap in parentContext so push row inherits release.
  const parentForContext = releaseJobId ?? options.parentJobId ?? undefined;
  if (!parentForContext) return startProjectPush(projectName, options);
  const { runWithParent } = await import('@/lib/jobs/parent-context');
  return runWithParent(parentForContext, () => startProjectPush(projectName, options));
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  const { safeStartOrchestrator } = await import('@/lib/workflows/safe-start-orchestrator');
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'push-phase');
}
