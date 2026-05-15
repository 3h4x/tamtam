// Vercel Workflow runtime for the release pipeline. Every release routes
// through this file — there is no legacy direct-call escape hatch.
//
// Two workflows live here:
//
//   1. releaseWorkflow — the route-facing entry point. Its body kicks off
//      the release (creates the meta-job, spawns the first sub-step), then
//      dispatches a child workflow that owns the rest of the chain.
//
//   2. releaseObservationWorkflow — a sibling workflow used only when
//      TAMTAM_RELEASE_WORKFLOW_DRIVE=0 forces the observation fallback.
//      Watches a sub-step via waitForJobCompletion and polls for the next
//      sibling job that completion hooks spawned, recursively dispatching
//      itself. Keeps the workflow_runs trace alive while leaving hooks in
//      charge of dispatch.
//
// The drive-mode path (default) dispatches `releaseOrchestratorWorkflow`
// (see release-orchestrator.ts), which DRIVES the chain by deciding the
// next phase and starting the matching phase workflow directly.

import type { StartReleaseOptions, ReleaseResult } from '@/lib/pipeline/start-release';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';

export type { NextPhase } from '@/lib/workflows/decide-next-phase';

export async function releaseWorkflow(
  projectName: string,
  options: StartReleaseOptions = {},
): Promise<ReleaseResult> {
  'use workflow';
  const release = await kickoffReleaseStep(projectName, options);
  if (release.ok && release.jobId) {
    // Default: workflow drives the chain via the orchestrator workflow.
    // The orchestrator dispatches the next phase workflow directly instead
    // of polling for the hook-spawned sibling. Completion hooks
    // short-circuit via the workflowDriven contextMeta flag stamped on
    // the release meta-job.
    //
    // TAMTAM_RELEASE_WORKFLOW_DRIVE=0: observation-only fallback. The
    // polling observation chain runs alongside the hook-driven pipeline.
    // No double-dispatch risk because the orchestrator path requires the
    // workflowDriven flag, and observation doesn't stamp it.
    const driveMode = await readDriveModeStep();
    if (driveMode && release.releaseJobId) {
      await dispatchOrchestratorStep(release.jobId, release.releaseJobId, projectName);
    } else {
      await dispatchObservationStep(release.jobId);
    }
  }
  return release;
}

async function kickoffReleaseStep(
  projectName: string,
  options: StartReleaseOptions,
): Promise<ReleaseResult> {
  'use step';
  const { startRelease } = await import('@/lib/pipeline/start-release');
  return startRelease(projectName, options);
}

async function dispatchObservationStep(jobId: string): Promise<void> {
  'use step';
  try {
    const { start } = await import('workflow/api');
    // start() enqueues the child workflow and returns a Run handle. We do
    // NOT await `run.returnValue` — the child runs independently.
    await start(releaseObservationWorkflow, [jobId]);
  } catch (err) {
    // Observation is non-critical: if dispatching the child fails (e.g.
    // workflow runtime hiccup), the parent release still proceeds via the
    // existing completion-hook chain. Log and swallow.
    console.error('[release-workflow] failed to dispatch observation child:', err);
  }
}

async function readDriveModeStep(): Promise<boolean> {
  'use step';
  // Reading env vars inside a step keeps the workflow body deterministic
  // for replay. (If we read process.env directly in the workflow body, a
  // replay after a flag change would short-circuit the cached step but
  // re-evaluate the env read, mismatching the original execution path.)
  return process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE !== '0';
}

async function dispatchOrchestratorStep(
  firstStepJobId: string,
  releaseJobId: string,
  projectName: string,
): Promise<void> {
  'use step';
  // Stamp the release meta-job as workflow-driven so completion hooks
  // short-circuit (see runCompletionHooksInner in lib/jobs/lifecycle.ts).
  try {
    const { getJob, updateJob } = await import('@/lib/jobs/job-storage');
    const { markReleaseWorkflowDriven } = await import('@/lib/workflows/workflow-driven-flag');
    const release = getJob(releaseJobId);
    if (release && release.kind === 'release') {
      markReleaseWorkflowDriven(release);
      updateJob(release);
    } else {
      console.warn(`[release-workflow] release meta-job ${releaseJobId} not found — proceeding without flag; double-dispatch possible`);
    }
  } catch (err) {
    console.error('[release-workflow] failed to stamp workflowDriven flag:', err);
  }

  // Dispatch the orchestrator child workflow. Independent run.
  try {
    const { start } = await import('workflow/api');
    const { releaseOrchestratorWorkflow } = await import('@/lib/workflows/release-orchestrator');
    await start(releaseOrchestratorWorkflow, [firstStepJobId, { projectName, parentJobId: releaseJobId }]);
  } catch (err) {
    console.error('[release-workflow] failed to dispatch orchestrator child:', err);
  }
}

export interface ObservationResult {
  waited: WaitForJobResult;
  decision: NextPhase | null;
}

/**
 * Sibling workflow dispatched from `releaseWorkflow`. Three steps:
 *
 *   1. observeJobCompletionStep — wait for the sub-step job to finish.
 *   2. decideNextPhaseStep — read kind/exit/verdict, compute NextPhase.
 *   3. dispatchNextObservationStep — when the decision is non-terminal,
 *      poll briefly for the next sub-step job (the completion-hook chain
 *      spawns it shortly after markDone) and recursively dispatch
 *      releaseObservationWorkflow for it. Builds a self-perpetuating
 *      observation chain that mirrors the actual pipeline.
 *
 * The Run holds a workflow_runs row open for the duration of the waited
 * sub-step, so the workflow event log captures the decision and the
 * dispatch (if any). Future iterations replace the polling in step 3 with
 * a direct dispatch of the next phase's workflow.
 *
 *   await start(releaseObservationWorkflow, [jobId])
 *
 * The dispatcher does not await the returned Run — this workflow runs
 * independently of its parent.
 */
export async function releaseObservationWorkflow(
  jobId: string,
): Promise<ObservationResult> {
  'use workflow';
  const waited = await observeJobCompletionStep(jobId);
  if (!waited.finished || !waited.job) return { waited, decision: null };
  const decision = await decideNextPhaseStep(waited.job.id);
  if (decision.next !== 'done' && decision.next !== 'abort' && decision.next !== 'unknown') {
    await dispatchNextObservationStep(jobId);
  }
  return { waited, decision };
}

async function observeJobCompletionStep(
  jobId: string,
): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}

async function decideNextPhaseStep(jobId: string): Promise<NextPhase> {
  'use step';
  const { getJob, getVerdict } = await import('@/lib/jobs/job-storage');
  const { decideNextPhase } = await import('@/lib/workflows/decide-next-phase');
  const job = getJob(jobId);
  if (!job) return { next: 'unknown', from: 'unknown', reason: `job ${jobId} not found in cache` };
  const verdict = job.kind === 'review' ? getVerdict(job) : null;
  return decideNextPhase({ kind: job.kind, exitCode: job.exitCode ?? -1, verdict });
}

/**
 * After the current sub-step finishes, the completion-hook chain in
 * lib/jobs/lifecycle.ts spawns the next sub-step. This step polls briefly
 * for that new job (filtered to the same releaseId, started after the
 * current one) and dispatches another observation workflow for it.
 *
 * Bounded polling: the next sub-step usually appears within seconds of
 * markDone. If it doesn't appear within NEXT_JOB_LOOKUP_MS, give up — the
 * chain has either finished (no follow-on) or hit a failure path the
 * observation workflow doesn't try to recover.
 */
/**
 * Step output — recorded in workflow_steps.output so operators can read the
 * chain's decision in the run detail UI.
 */
export type DispatchOutcome =
  | { dispatched: false; reason: 'prev_not_found' }
  | { dispatched: false; reason: 'prev_not_finished' }
  | { dispatched: false; reason: 'no_sibling_within_window' }
  | { dispatched: true; nextJobId: string; foundAfterMs: number }
  | { dispatched: false; reason: 'dispatch_failed'; nextJobId: string; error: string };

async function dispatchNextObservationStep(prevJobId: string): Promise<DispatchOutcome> {
  'use step';
  const NEXT_JOB_LOOKUP_MS = 30_000;
  const POLL_INTERVAL_MS = 1_000;
  const { getJob, listJobs } = await import('@/lib/jobs/job-storage');
  const { findNextSubStepJob } = await import('@/lib/workflows/find-next-substep');
  const prev = getJob(prevJobId);
  if (!prev) return { dispatched: false, reason: 'prev_not_found' };
  if (prev.finishedAt == null) return { dispatched: false, reason: 'prev_not_finished' };

  const startedLookupAt = Date.now();
  const deadline = startedLookupAt + NEXT_JOB_LOOKUP_MS;
  while (Date.now() < deadline) {
    const next = findNextSubStepJob(listJobs(), prev);
    if (next) {
      const foundAfterMs = Date.now() - startedLookupAt;
      try {
        const { start } = await import('workflow/api');
        await start(releaseObservationWorkflow, [next.id]);
        return { dispatched: true, nextJobId: next.id, foundAfterMs };
      } catch (err) {
        console.error('[release-workflow] failed to dispatch next observation child:', err);
        return {
          dispatched: false,
          reason: 'dispatch_failed',
          nextJobId: next.id,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // No follow-on appeared. Either the chain finished or a hook crashed.
  return { dispatched: false, reason: 'no_sibling_within_window' };
}
