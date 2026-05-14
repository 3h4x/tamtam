// Sixth per-phase workflow scaffold: fix-push. Triggered when a push
// fails because a pre-push hook (lint/format/typecheck) rejected the
// commit. Claude reads the hook error and fixes the offending files; the
// orchestrator then re-runs push.
//
// Shape mirrors test/review/fix: kickoff → await → return. Takes
// hookError as a required second arg — that's the rejection text Claude
// uses to identify what to fix.
//
// Future iterations dispatch this when the orchestrator decides
// { next: 'fix-push', from: 'push' }. Not wired yet.

import type { StartFixPushResult } from '@/lib/pipeline/start-fix-push';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';

export type FixPushPhaseResult =
  | {
      ok: true;
      jobId: string;
      finished: boolean;
      reason: WaitForJobResult['reason'];
      exitCode: number | null;
    }
  | {
      ok: false;
      reason: 'start_failed';
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releaseFixPushPhaseWorkflow(
  projectName: string,
  hookError: string,
): Promise<FixPushPhaseResult> {
  'use workflow';
  const started = await spawnFixPushStep(projectName, hookError);
  if (!started.ok) {
    return {
      ok: false,
      reason: 'start_failed',
      status: started.status,
      detail: started.detail,
      ...(started.blockingJobId ? { blockingJobId: started.blockingJobId } : {}),
    };
  }
  const waited = await awaitFixPushCompletionStep(started.jobId);
  return {
    ok: true,
    jobId: started.jobId,
    finished: waited.finished,
    reason: waited.reason,
    exitCode: waited.job?.exitCode ?? null,
  };
}

async function spawnFixPushStep(
  projectName: string,
  hookError: string,
): Promise<StartFixPushResult> {
  'use step';
  const { startFixPush } = await import('@/lib/pipeline/start-fix-push');
  return startFixPush(projectName, hookError);
}

async function awaitFixPushCompletionStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}
