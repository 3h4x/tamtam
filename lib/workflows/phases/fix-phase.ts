// Third per-phase workflow scaffold: fix. Slightly different shape from
// test/review — fix runs in the context of an earlier (failed) job: a test
// that exited non-zero or a review that returned NEEDS ATTENTION. The
// existing startFixFromJob helper takes a sourceJobId pointing at that
// parent.
//
// Future iterations dispatch this workflow when the orchestrator decides
// { next: 'fix', from: 'test' | 'review' }. Not wired yet.

import type { StartFixResult } from '@/lib/pipeline/start-fix';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';

export type FixPhaseResult =
  | {
      ok: true;
      jobId: string;
      sourceJobId: string;
      finished: boolean;
      reason: WaitForJobResult['reason'];
      exitCode: number | null;
    }
  | {
      ok: false;
      reason: 'start_failed';
      sourceJobId: string;
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releaseFixPhaseWorkflow(sourceJobId: string): Promise<FixPhaseResult> {
  'use workflow';
  const started = await spawnFixStep(sourceJobId);
  if (!started.ok) {
    return {
      ok: false,
      reason: 'start_failed',
      sourceJobId,
      status: started.status,
      detail: started.detail,
      ...(started.blockingJobId ? { blockingJobId: started.blockingJobId } : {}),
    };
  }
  const waited = await awaitFixCompletionStep(started.jobId);
  return {
    ok: true,
    jobId: started.jobId,
    sourceJobId,
    finished: waited.finished,
    reason: waited.reason,
    exitCode: waited.job?.exitCode ?? null,
  };
}

async function spawnFixStep(sourceJobId: string): Promise<StartFixResult> {
  'use step';
  const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
  return startFixFromJob(sourceJobId);
}

async function awaitFixCompletionStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}
