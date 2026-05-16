// graphile-worker task: project-sweep
//
// Fires every 5 minutes. Walks every enabled project; releases non-default
// branches with pending work, and dispatches pr-wait on clean non-default
// branches with a ready-to-merge PR. Default-branch work needs an explicit
// trigger. Mirrors the system-cron self-reenqueue pattern so the chain
// survives Next.js restarts.

import type { JobHelpers, Task } from 'graphile-worker';

export const PROJECT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const PROJECT_SWEEP_JOB_KEY = 'project-sweep';

export interface ProjectSweepDeps {
  runSweep: () => Promise<void>;
  enqueueNextFire: (runAt: Date) => Promise<void>;
  isEnabled: () => Promise<boolean> | boolean;
  now?: () => number;
}

export interface ProjectSweepResult {
  ran: boolean;
  error?: string;
  nextFireAt: Date;
}

export async function handleProjectSweep(deps: ProjectSweepDeps): Promise<ProjectSweepResult> {
  const now = deps.now ?? Date.now;
  let ran = false;
  let error: string | undefined;
  try {
    const enabled = await deps.isEnabled();
    if (enabled) {
      await deps.runSweep();
      ran = true;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const nextFireAt = new Date(now() + PROJECT_SWEEP_INTERVAL_MS);
  await deps.enqueueNextFire(nextFireAt);
  return { ran, error, nextFireAt };
}

export function createProjectSweepTask(deps: ProjectSweepDeps): Task {
  return async (_payload, helpers: JobHelpers) => {
    const r = await handleProjectSweep(deps);
    if (r.error) {
      helpers.logger.error(`project-sweep: ${r.error}; re-enqueued at ${r.nextFireAt.toISOString()}`);
    } else if (r.ran) {
      helpers.logger.info(`project-sweep: ok, next fire ${r.nextFireAt.toISOString()}`);
    } else {
      helpers.logger.info(`project-sweep: disabled (skipped), next fire ${r.nextFireAt.toISOString()}`);
    }
  };
}
