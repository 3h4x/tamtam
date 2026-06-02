// Shared workflow step: decide whether a phase-start 409 is safe to attach to.
//
// When a phase workflow tries to start its sub-step but loses the atomic
// per-(release, phase) start claim (lib/pipeline/pipeline-start-slot.ts), or
// hits the legacy "already in progress" guard, `startProject*` returns a 409
// carrying the in-flight job id. That's a TRANSIENT concurrency condition
// (another orchestrator resume already started this phase for the same
// release), NOT a real failure. Rather than abort the release, the phase
// should attach to the in-flight job and continue the chain from its result —
// the in-flight job covers the same working tree.
//
// This is the generalized form of review-phase's original
// `resolveAttachableReviewStep`. Returns the job id to attach to when the
// blocker is a job of the SAME kind for THIS project, else null (a genuine
// conflict — e.g. a pipeline-lock 409 blocked by some other kind — which
// falls through to the phase's failure path).

export async function resolveAttachableInflightStep(
  blockingJobId: string | undefined,
  projectName: string,
  kind: string,
): Promise<string | null> {
  'use step';
  if (!blockingJobId) return null;
  const { getJob } = await import('@/lib/jobs/job-storage');
  const j = getJob(blockingJobId);
  if (j && j.kind === kind && j.project === projectName) return blockingJobId;
  return null;
}
