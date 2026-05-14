// The state machine, finally.
//
// `releaseOrchestratorWorkflow` takes a sub-step jobId, waits for it to
// finish, decides the next phase, and dispatches the matching phase
// workflow — which itself is a child workflow that runs independently and,
// when finished, can dispatch the next orchestrator tick for ITS sub-step
// jobId. The chain self-perpetuates exactly like releaseObservationWorkflow
// does today, but instead of POLLING for the next sibling job that
// completion hooks spawned, it DRIVES the next phase directly.
//
// Not yet dispatched from anywhere — the existing
// releaseObservationWorkflow still runs in production. Future iteration
// flips the wiring: when TAMTAM_RELEASE_WORKFLOW_DRIVE=1, releaseWorkflow
// dispatches releaseOrchestratorWorkflow instead of
// releaseObservationWorkflow. The completion-hook chain for release kinds
// would need to skip dispatching downstream steps when a workflow is
// driving (otherwise we double-dispatch).
//
// Pre-conditions for that flip:
//   1. Build a way to mark a release job as "workflow-driven" so hooks
//      know to skip (e.g. job.context_meta.workflowDriven = true).
//   2. Add the matching skip in lib/jobs/lifecycle.ts's chain logic.
//   3. Add an env-gated branch in releaseWorkflow to dispatch this
//      workflow instead of releaseObservationWorkflow.
//
// Until those land, this file is structural scaffolding that the dispatcher
// can be exercised against in tests.

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
