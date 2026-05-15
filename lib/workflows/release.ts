// Vercel Workflow runtime for the release pipeline. Every release routes
// through this file. The orchestrator (see release-orchestrator.ts) drives
// the chain by deciding the next phase and starting the matching phase
// workflow directly; phase workflows re-dispatch the orchestrator for the
// next tick, and the chain finalizes when the orchestrator sees a terminal
// decision.
//
// Completion hooks short-circuit via the `workflowDriven` contextMeta flag
// stamped on the release meta-job — they no longer chain releases.

import type { StartReleaseOptions, ReleaseResult } from '@/lib/pipeline/start-release';

export type { NextPhase } from '@/lib/workflows/decide-next-phase';

export async function releaseWorkflow(
  projectName: string,
  options: StartReleaseOptions = {},
): Promise<ReleaseResult> {
  'use workflow';
  const release = await kickoffReleaseStep(projectName, options);
  if (release.ok && release.jobId && release.releaseJobId) {
    await dispatchOrchestratorStep(release.jobId, release.releaseJobId, projectName);
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
