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
  // Release-linked pipeline steps are owned by the orchestrator; the
  // lifecycle completion hook short-circuits on `releaseId`.
  const { safeStartOrchestrator } = await import('@/lib/workflows/safe-start-orchestrator');
  await safeStartOrchestrator(firstStepJobId, projectName, releaseJobId, 'release-workflow');
}
