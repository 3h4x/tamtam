// Test phase workflow. Drives the "test" phase of the release pipeline:
// spawn the test sub-step via the existing fire-and-forget startProjectTest
// helper, then await its completion via waitForJobCompletion, then return a
// structured outcome.
//
// Pattern shared by the phase workflows:
//
//   1. kickoff step — wraps the existing startProject* helper. Cheap; returns
//      immediately with the jobId or an ok:false reason.
//   2. wait step — polls until finishedAt is set (or timeout/abort).
//   3. workflow body chains them with a deterministic if-not-ok-return guard.
//   4. The workflow returns a discriminated TestPhaseResult so callers can
//      branch (next: review on success, next: fix on failure) without
//      replicating decision logic.
//
// Dispatched through dispatch-phase.ts as one workflow phase per chain tick;
// this phase wraps start-test.

import type { StartTestResult } from '@/lib/pipeline/start-test';
import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';
import { safeStartOrchestrator } from '@/lib/workflows/safe-start-orchestrator';
import { resolveAttachableInflightStep } from '@/lib/workflows/phases/attach-inflight';

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
  options: { reviewRetest?: boolean } = {},
): Promise<TestPhaseResult> {
  'use workflow';
  const started = await spawnTestStep(projectName, releaseJobId, options);
  let testJobId: string;
  let testCmd = '';
  if (started.ok) {
    testJobId = started.jobId;
    testCmd = started.testCmd;
  } else {
    // A 409 means another orchestrator resume already started this phase's
    // test for the release (lost the atomic start claim). Attach to the
    // in-flight test and continue instead of aborting the release.
    const attach = started.status === 409
      ? await resolveAttachableInflightStep(started.blockingJobId, projectName, 'test')
      : null;
    if (!attach) {
      return {
        ok: false,
        reason: 'start_failed',
        status: started.status,
        detail: started.detail,
        ...(started.blockingJobId ? { blockingJobId: started.blockingJobId } : {}),
      };
    }
    testJobId = attach;
  }
  const waited = await awaitTestCompletionStep(testJobId);
  // Close the loop: re-dispatch the orchestrator for this sub-step so the
  // chain continues fully through workflow runs (test → review on pass,
  // test → fix on fail).
  if (waited.finished && releaseJobId) {
    await dispatchOrchestratorTickStep(testJobId, projectName, releaseJobId);
  }
  return {
    ok: true,
    jobId: testJobId,
    finished: waited.finished,
    reason: waited.reason,
    exitCode: waited.job?.exitCode ?? null,
    testCmd,
  };
}

async function spawnTestStep(
  projectName: string,
  releaseJobId?: string,
  options: { reviewRetest?: boolean } = {},
): Promise<StartTestResult> {
  'use step';
  const { startProjectTest } = await import('@/lib/pipeline/start-test');
  // See review-phase.ts for the rationale: parentContext doesn't carry across
  // workflow step boundaries, so wrap explicitly to preserve release linkage.
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
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'test-phase');
}
