// Fifth per-phase workflow scaffold: commit. Same shape as push — commit
// runs inline in the server (no background job to await), so the phase
// workflow has a single 'use step'. CommitResult carries the optional
// jobId for traceability (commit may be linked to a jobs-table row even
// though it isn't a spawned subprocess).
//
// Future iterations dispatch this when the orchestrator decides
// { next: 'commit' } — usually before push when there are uncommitted
// changes from a fix loop. Not wired yet.

import type { CommitResult } from '@/lib/pipeline/start-commit';

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
    // Commit failures route to fix via the orchestrator (commit fail → fix).
    // We don't have a jobId here unless start-commit created a row; if it did,
    // re-dispatch so the orchestrator can decide.
    if (releaseJobId) {
      await dispatchOrchestratorTickStep(null, projectName, releaseJobId);
    }
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
  jobId: string | null,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  if (!jobId) return;
  const { safeStartOrchestrator } = await import('@/lib/workflows/safe-start-orchestrator');
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'commit-phase');
}
