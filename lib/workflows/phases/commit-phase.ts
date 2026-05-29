// Commit phase workflow. Same shape as push — commit
// runs inline in the server (no background job to await), so the phase
// workflow has a single 'use step'. CommitResult carries the optional
// jobId for traceability (commit may be linked to a jobs-table row even
// though it isn't a spawned subprocess).
//
// Dispatched by releaseOrchestratorWorkflow via dispatchPhase when the
// orchestrator decides { next: 'commit' }, usually before push when there
// are uncommitted changes from a fix loop.

import type { CommitResult } from '@/lib/pipeline/start-commit';
import { safeStartOrchestrator } from '@/lib/workflows/safe-start-orchestrator';

export type CommitPhaseResult =
  | {
      ok: true;
      commitSha: string;
      message: string;
      jobId?: string;
    }
  | {
      ok: false;
      reason: 'commit_failed';
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releaseCommitPhaseWorkflow(
  projectName: string,
  options: { parentJobId?: string | null } = {},
  releaseJobId?: string,
): Promise<CommitPhaseResult> {
  'use workflow';
  const r = await commitStep(projectName, options, releaseJobId);
  if (!r.ok) {
    return {
      ok: false,
      reason: 'commit_failed',
      status: r.status,
      detail: r.detail,
      ...(r.blockingJobId ? { blockingJobId: r.blockingJobId } : {}),
    };
  }
  // commit success → re-dispatch so orchestrator chains into push.
  if (releaseJobId && r.jobId) {
    await dispatchOrchestratorTickStep(r.jobId, projectName, releaseJobId);
  }
  return {
    ok: true,
    commitSha: r.commitSha,
    message: r.message,
    ...(r.jobId ? { jobId: r.jobId } : {}),
  };
}

async function commitStep(
  projectName: string,
  options: { parentJobId?: string | null },
  releaseJobId?: string,
): Promise<CommitResult> {
  'use step';
  const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
  // See review-phase.ts: wrap in parentContext so commit row inherits release.
  const parentForContext = releaseJobId ?? options.parentJobId ?? undefined;
  if (!parentForContext) return startProjectCommit(projectName, options);
  const { runWithParent } = await import('@/lib/jobs/parent-context');
  return runWithParent(parentForContext, () => startProjectCommit(projectName, options));
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'commit-phase');
}
