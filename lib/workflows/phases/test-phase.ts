// First per-phase workflow scaffold. Drives the "test" phase of the
// release pipeline: spawn the test sub-step via the existing fire-and-
// forget startProjectTest helper, then await its completion via
// waitForJobCompletion, then return a structured outcome.
//
// Pattern this file establishes for future phase workflows (review, fix,
// commit, push, mark-dod, pr-wait):
//
//   1. kickoff step — wraps the existing startProject* helper. Cheap; returns
//      immediately with the jobId or an ok:false reason.
//   2. wait step — polls until finishedAt is set (or timeout/abort).
//   3. workflow body chains them with a deterministic if-not-ok-return guard.
//   4. The workflow returns a discriminated TestPhaseResult so callers can
//      branch (next: review on success, next: fix on failure) without
//      replicating decision logic.
//
// Dispatched by releaseOrchestratorWorkflow. The orchestrator invokes one
// phase workflow per chain tick; this one wraps start-test.

import type { StartTestResult } from '@/lib/pipeline/start-test';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';

export type TestPhaseResult =
  | {
      ok: true;
      jobId: string;
      finished: boolean;
      reason: WaitForJobResult['reason'];
      exitCode: number | null;
      testCmd: string;
    }
  | {
      ok: false;
      reason: 'start_failed';
      status: number;
      detail: string;
      blockingJobId?: string;
    };

export async function releaseTestPhaseWorkflow(
  projectName: string,
  releaseJobId?: string,
): Promise<TestPhaseResult> {
  'use workflow';
  const started = await spawnTestStep(projectName, releaseJobId);
  if (!started.ok) {
    return {
      ok: false,
      reason: 'start_failed',
      status: started.status,
      detail: started.detail,
      ...(started.blockingJobId ? { blockingJobId: started.blockingJobId } : {}),
    };
  }
  const waited = await awaitTestCompletionStep(started.jobId);
  // Close the loop: re-dispatch the orchestrator for this sub-step so the
  // chain continues fully through workflow runs (test → review on pass,
  // test → fix on fail).
  if (waited.finished && releaseJobId) {
    await dispatchOrchestratorTickStep(started.jobId, projectName, releaseJobId);
  }
  return {
    ok: true,
    jobId: started.jobId,
    finished: waited.finished,
    reason: waited.reason,
    exitCode: waited.job?.exitCode ?? null,
    testCmd: started.testCmd,
  };
}

async function spawnTestStep(
  projectName: string,
  releaseJobId?: string,
): Promise<StartTestResult> {
  'use step';
  const { startProjectTest } = await import('@/lib/pipeline/start-test');
  // See review-phase.ts for the rationale: parentContext doesn't carry across
  // workflow step boundaries, so wrap explicitly to preserve release linkage.
  if (!releaseJobId) return startProjectTest(projectName);
  const { runWithParent } = await import('@/lib/jobs/parent-context');
  return runWithParent(releaseJobId, () => startProjectTest(projectName));
}

async function awaitTestCompletionStep(jobId: string): Promise<WaitForJobResult> {
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
  try {
    const { start } = await import('workflow/api');
    const { releaseOrchestratorWorkflow } = await import('@/lib/workflows/release-orchestrator');
    await start(releaseOrchestratorWorkflow, [jobId, { projectName, parentJobId: releaseJobId }]);
  } catch (err) {
    console.error('[test-phase] failed to re-dispatch orchestrator:', err);
  }
}
