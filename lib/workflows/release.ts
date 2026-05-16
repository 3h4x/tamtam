// Vercel Workflow runtime for the release pipeline. Every release routes
// through this file. The orchestrator (see release-orchestrator.ts) drives
// the chain by deciding the next phase and starting the matching phase
// workflow directly; phase workflows re-dispatch the orchestrator for the
// next tick, and the chain finalizes when the orchestrator sees a terminal
// decision.
//
// The legacy completion-hook chain in lib/jobs/lifecycle.ts short-circuits
// on `releaseId` for any pipeline step linked to a release — the
// orchestrator owns chaining alone.

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
  // The legacy `workflowDriven` contextMeta flag stamping was removed when
  // the lifecycle short-circuit moved to gating on `releaseId` directly
  // (see lib/jobs/lifecycle.ts: `if (job.releaseId) return;`). Every
  // release-linked pipeline step is owned by the orchestrator regardless
  // of any flag — gating on linkage is more robust than a stamped marker
  // (cascade #3 in the migration session was the canonical proof: stale
  // flag stamps caused double-dispatch when the spawn site lost releaseId).
  const { safeStartOrchestrator } = await import('@/lib/workflows/safe-start-orchestrator');
  await safeStartOrchestrator(firstStepJobId, projectName, releaseJobId, 'release-workflow');
}
