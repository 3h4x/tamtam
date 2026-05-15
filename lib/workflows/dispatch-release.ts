// Helper for triggering a release through the workflow runtime.
//
// Anywhere outside the release workflow body itself (HTTP route, completion
// hook, pending-release drain, on-demand resume route) should call this
// instead of `startRelease` directly so every release gets a `workflow_runs`
// row and the orchestrator (or observation fallback) gets a chance to drive.
//
// The release workflow's body still calls `startRelease` inline inside its
// kickoffReleaseStep — that's the one allowed direct caller. Everywhere else
// goes through this helper.

import type { StartReleaseOptions, ReleaseResult } from '@/lib/pipeline/start-release';

export async function dispatchReleaseWorkflow(
  projectName: string,
  options: StartReleaseOptions = {},
): Promise<ReleaseResult> {
  const { start } = await import('workflow/api');
  const { releaseWorkflow } = await import('@/lib/workflows/release');
  const run = await start(releaseWorkflow, [projectName, options]);
  return run.returnValue;
}
