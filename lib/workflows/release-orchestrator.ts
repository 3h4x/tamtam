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
// Active by default via `releaseWorkflow`. The release meta-job is stamped
// with `contextMeta.workflowDriven = true`, and the completion-hook chain
// in lib/jobs/lifecycle.ts short-circuits on that flag so the orchestrator
// owns dispatch alone (no double-dispatch).
//
// Set TAMTAM_RELEASE_WORKFLOW_DRIVE=0 to fall back to the polling
// observation chain (releaseObservationWorkflow); the workflow runtime
// itself is always on (no direct-call bypass).

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
  const dispatch = await dispatchStep(decision, { ...ctx, prevJobId: waited.job.id });
  // When the chain reaches a terminal decision (done / abort / unknown),
  // finalize the release meta-job so its row in /runs reflects the actual
  // outcome instead of staying open until the legacy reconciler reaps it.
  if (
    dispatch.dispatched === false &&
    dispatch.reason === 'terminal' &&
    ctx.parentJobId
  ) {
    await finalizeReleaseStep(ctx.parentJobId, dispatch.phase, waited.job.exitCode ?? 0);
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
  const { getJob, getVerdict } = await import('@/lib/jobs/job-storage');
  const { decideNextPhase } = await import('@/lib/workflows/decide-next-phase');
  const job = getJob(jobId);
  if (!job) return { next: 'unknown', from: 'unknown', reason: `job ${jobId} not found in cache` };
  const verdict = job.kind === 'review' ? getVerdict(job) : null;
  return decideNextPhase({ kind: job.kind, exitCode: job.exitCode ?? -1, verdict });
}

async function dispatchStep(
  decision: NextPhase,
  ctx: DispatchContext,
): Promise<DispatchPhaseOutcome> {
  'use step';
  const { dispatchPhase } = await import('@/lib/workflows/dispatch-phase');
  return dispatchPhase(decision, ctx);
}

async function finalizeReleaseStep(
  releaseJobId: string,
  terminalPhase: 'done' | 'abort' | 'unknown',
  lastStepExitCode: number,
): Promise<void> {
  'use step';
  const { getJob } = await import('@/lib/jobs/job-storage');
  const { finalizeReleaseJob, finalizeAbortedRelease } = await import('@/lib/jobs/lifecycle');
  const release = getJob(releaseJobId);
  if (!release || release.kind !== 'release' || release.finishedAt !== null) return;
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
