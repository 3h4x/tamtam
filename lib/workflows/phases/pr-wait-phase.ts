// Eighth per-phase workflow scaffold: pr-wait. The last of the eight
// scaffolds — once all phases exist, the release-workflow body becomes
// the actual orchestrator that dispatches them.
//
// pr-wait polls the PR's CI status until it passes (then merges) or
// fails / times out. launchPrWait returns synchronously with a jobId,
// the polling loop runs inside the Next.js process and finalises the
// job via markDone(0) on merge or markDone(1) on failure/timeout.
//
// Future iterations dispatch this when the orchestrator decides
// { next: 'pr-wait' } and the push opened/reused a PR. Not wired yet.

import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';

export type PrWaitPhaseResult =
  | {
      ok: true;
      jobId: string;
      finished: boolean;
      merged: boolean;
      reason: WaitForJobResult['reason'];
      exitCode: number | null;
    }
  | {
      ok: false;
      reason: 'launch_failed';
      error: string;
    };

export async function releasePrWaitPhaseWorkflow(
  projectName: string,
  prNumber: number,
  prRepo: string,
  prUrl: string,
): Promise<PrWaitPhaseResult> {
  'use workflow';
  const launched = await launchPrWaitStep(projectName, prNumber, prRepo, prUrl);
  if (!('jobId' in launched)) {
    return { ok: false, reason: 'launch_failed', error: launched.error };
  }
  const waited = await awaitPrWaitCompletionStep(launched.jobId);
  // exitCode 0 = merge succeeded, 1 = transient / permanent / timeout failure.
  // See runPrWaitLoop in start-pr-wait.ts for the markDone codes.
  const exitCode = waited.job?.exitCode ?? null;
  const merged = waited.finished && exitCode === 0;
  return {
    ok: true,
    jobId: launched.jobId,
    finished: waited.finished,
    merged,
    reason: waited.reason,
    exitCode,
  };
}

async function launchPrWaitStep(
  projectName: string,
  prNumber: number,
  prRepo: string,
  prUrl: string,
): Promise<{ jobId: string } | { error: string }> {
  'use step';
  const { launchPrWait } = await import('@/lib/pipeline/start-pr-wait');
  return launchPrWait(projectName, prNumber, prRepo, prUrl);
}

async function awaitPrWaitCompletionStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  // pr-wait can run up to 30 minutes (TAMTAM_PR_WAIT_TIMEOUT_MS). Use a
  // 60-min wait ceiling so our await still completes after the underlying
  // pr-wait loop times out itself.
  return waitForJobCompletion(jobId, { timeoutMs: 60 * 60 * 1000 });
}
