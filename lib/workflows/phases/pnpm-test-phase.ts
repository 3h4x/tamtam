import type { StartTestResult } from '@/lib/pipeline/start-test';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';
import { safeStartOrchestrator } from '@/lib/workflows/safe-start-orchestrator';

// Plain test phase workflow. It intentionally reuses the direct test runner
// instead of buffering command output in the workflow process, so test jobs
// keep the same durable lifecycle contract as `/test`: real child pid,
// streamed log writes, exit-code sentinel, and close-handler race guard.

export interface PnpmTestPhaseResult {
  ok: boolean;
  jobId: string | null;
  exitCode: number | null;
  reason: 'finished' | 'timeout' | 'aborted' | 'not_found' | 'start_failed' | 'no_command';
  detail?: string;
}

export async function pnpmTestPhaseWorkflow(
  projectName: string,
  releaseJobId?: string,
  options: { reviewRetest?: boolean } = {},
): Promise<PnpmTestPhaseResult> {
  'use workflow';
  const started = await spawnPlainTestStep(projectName, releaseJobId, options);
  if (!started.ok) {
    const noCommand = started.status === 400 && /detect test command/i.test(started.detail);
    return {
      ok: false,
      jobId: null,
      exitCode: null,
      reason: noCommand ? 'no_command' : 'start_failed',
      detail: started.detail,
    };
  }

  const waited = await awaitPlainTestCompletionStep(started.jobId);
  if (waited.finished && releaseJobId) {
    await dispatchOrchestratorTickStep(started.jobId, projectName, releaseJobId);
  }

  return {
    ok: waited.finished,
    jobId: started.jobId,
    // exitCode is meaningless until the job actually finishes — return null
    // on timeout/aborted/not_found rather than leaking a stale 0 from the
    // job row's default.
    exitCode: waited.finished ? (waited.job?.exitCode ?? null) : null,
    reason: waited.reason,
    ...(waited.reason === 'not_found' ? { detail: `test job '${started.jobId}' not found` } : {}),
  };
}

async function spawnPlainTestStep(
  projectName: string,
  releaseJobId?: string,
  options: { reviewRetest?: boolean } = {},
): Promise<StartTestResult> {
  'use step';
  const { startProjectTest } = await import('@/lib/pipeline/start-test');
  if (!releaseJobId) {
    return options.reviewRetest
      ? startProjectTest(projectName, options)
      : startProjectTest(projectName);
  }
  const { runWithParent } = await import('@/lib/jobs/parent-context');
  return runWithParent(releaseJobId, () =>
    options.reviewRetest
      ? startProjectTest(projectName, options)
      : startProjectTest(projectName),
  );
}

async function awaitPlainTestCompletionStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'pnpm-test-phase');
}
