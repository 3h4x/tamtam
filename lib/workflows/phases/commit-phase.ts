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
): Promise<CommitPhaseResult> {
  'use workflow';
  const r = await commitStep(projectName, options);
  if (!r.ok) {
    return {
      ok: false,
      reason: 'commit_failed',
      status: r.status,
      detail: r.detail,
      ...(r.blockingJobId ? { blockingJobId: r.blockingJobId } : {}),
    };
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
): Promise<CommitResult> {
  'use step';
  const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
  return startProjectCommit(projectName, options);
}
