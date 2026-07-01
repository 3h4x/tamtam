// Mark-dod phase workflow. Verifies which acceptance criteria are actually
// implemented on the current branch and ticks the verified boxes in the
// issue/PR body.
//
// The flow runs across three workflow steps:
//
//   1. `prepareAndFetchStep` — resolves issue/PR context, creates the job
//      row, fetches the gh body, extracts criteria, switches the working
//      tree to the verification branch. Returns the bundle that the other
//      steps need, or a terminal result when there's nothing to verify.
//
//   2. `claudeVerifyStep` — spawns Claude with read-only tools to verify
//      each criterion against the codebase. This is the expensive step
//      whose result the workflow runtime caches; a server restart between
//      verify and apply doesn't re-burn tokens.
//
//   3. `applyAndFinalizeStep` — ticks the verified boxes, runs gh edit,
//      restores the original branch, calls markDone.

import type {
  MarkDodPrepBundle,
  MarkDodFetchBundle,
  MarkDodBranchSwitch,
  MarkDodClaudeVerifyResult,
  MarkDodVerifyDispatch,
  MarkDodResult,
} from '@/lib/workflows/phases/mark-dod-impl';
import { safeStartOrchestrator } from '@/lib/workflows/safe-start-orchestrator';

export type MarkDodPhaseResult =
  | {
      ok: true;
      jobId: string;
      issueNumber: number;
      verified: number;
      total: number;
      changed: boolean;
    }
  | {
      ok: true;
      skipped: true;
      reason: 'no_context';
    }
  | {
      ok: false;
      reason: 'mark_dod_failed';
      status: number;
      detail: string;
    };

export interface MarkDodOverride {
  issueNumber?: number;
  prNumber?: number;
  repo?: string;
}

type PrepareAndFetchResult =
  | {
      stage: 'terminal';
      result: MarkDodResult;
    }
  | {
      stage: 'continue';
      bundle: MarkDodPrepBundle;
      fetched: MarkDodFetchBundle;
      branchSwitch: MarkDodBranchSwitch;
    };

export async function releaseMarkDodPhaseWorkflow(
  projectName: string,
  override?: MarkDodOverride,
  releaseJobId?: string,
): Promise<MarkDodPhaseResult> {
  'use workflow';

  const prep = await prepareAndFetchStep(projectName, override, releaseJobId);
  if (prep.stage === 'terminal') {
    // mark-dod is the terminal phase. If we bailed early (no context, no
    // criteria, etc.) and have no sub-step jobId for the orchestrator to
    // wait on, finalize the release directly so the meta-job row reflects
    // the chain's outcome.
    if (releaseJobId) {
      const jobId = prep.result.ok ? prep.result.jobId : '';
      if (jobId) {
        await dispatchOrchestratorTickStep(jobId, projectName, releaseJobId);
      } else {
        await finalizeReleaseDirectlyStep(releaseJobId, 0);
      }
    }
    return toPhaseResult(prep.result);
  }

  // Dispatch the supervised verify job, wait for it, then read its result. The
  // three-step split is load-bearing: a single combined step would, on workflow
  // replay after a mid-verify restart, re-run createJob + startJobInProcess and
  // spawn a DUPLICATE token-burning verify job. Splitting caches the verifyJobId
  // so a replay only re-waits/re-reads (both idempotent).
  const dispatch = await dispatchVerifyStep(prep.bundle, projectName, prep.fetched);
  let verify: MarkDodClaudeVerifyResult;
  if ('terminal' in dispatch) {
    verify = { verifiedTexts: [], rawOutput: '', exitCode: 1, timedOut: false, terminal: dispatch.terminal };
  } else {
    await awaitVerifyStep(dispatch.verifyJobId);
    verify = await readVerifyResultStep(dispatch.verifyJobId, prep.bundle, prep.fetched);
  }

  const final = await applyAndFinalizeStep(prep.bundle, prep.fetched, verify, prep.branchSwitch);
  // mark-dod is a terminal phase. Re-dispatch the orchestrator so it sees
  // decideNextPhase=done and finalizes the release meta-job. If mark-dod's
  // own job is unavailable, finalize the release directly.
  if (releaseJobId) {
    if (final.ok) {
      await dispatchOrchestratorTickStep(final.jobId, projectName, releaseJobId);
    } else {
      await finalizeReleaseDirectlyStep(releaseJobId, final.status >= 500 ? 1 : 0);
    }
  }
  return toPhaseResult(final);
}

function toPhaseResult(r: MarkDodResult): MarkDodPhaseResult {
  if (r.ok) {
    return {
      ok: true,
      jobId: r.jobId,
      issueNumber: r.issueNumber,
      verified: r.verified,
      total: r.total,
      changed: r.changed,
    };
  }
  // No PR/issue context means mark-dod doesn't apply — skip cleanly rather than fail.
  if (r.status === 400 && r.detail === 'no issue or PR context on latest run') {
    return { ok: true, skipped: true, reason: 'no_context' };
  }
  return { ok: false, reason: 'mark_dod_failed', status: r.status, detail: r.detail };
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function prepareAndFetchStep(
  projectName: string,
  override: MarkDodOverride | undefined,
  releaseJobId?: string,
): Promise<PrepareAndFetchResult> {
  'use step';
  const impl = await import('@/lib/workflows/phases/mark-dod-impl');

  // Wrap the createJob call in runWithParent so the spawned mark-dod row
  // inherits release_id when the phase is part of a release chain. Without
  // this, the orchestrator's mark-dod → pr-wait routing can't fire (it
  // gates on job.releaseId), and pipeline trace/grouping is broken.
  const prepFn = () => impl.prepareMarkDod(projectName, override);
  let prep;
  if (releaseJobId) {
    const { runWithParent } = await import('@/lib/jobs/parent-context');
    prep = await runWithParent(releaseJobId, prepFn);
  } else {
    prep = await prepFn();
  }
  if ('ok' in prep) {
    return { stage: 'terminal', result: prep };
  }
  const { bundle, job } = prep;

  const fetched = await impl.fetchAndExtractMarkDodCriteria(bundle, job);
  if (fetched.terminal) return { stage: 'terminal', result: fetched.terminal };

  const branchSwitch = await impl.switchBranchForMarkDodVerification(bundle, job);

  return { stage: 'continue', bundle, fetched, branchSwitch };
}

async function dispatchVerifyStep(
  bundle: MarkDodPrepBundle,
  projectName: string,
  fetched: MarkDodFetchBundle,
): Promise<MarkDodVerifyDispatch> {
  'use step';
  const impl = await import('@/lib/workflows/phases/mark-dod-impl');
  const { getJob } = await import('@/lib/jobs/job-storage');
  const job = getJob(bundle.jobId);
  return impl.startMarkDodVerification(bundle, job, projectName, fetched);
}

async function awaitVerifyStep(verifyJobId: string): Promise<void> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  await waitForJobCompletion(verifyJobId);
}

async function readVerifyResultStep(
  verifyJobId: string,
  bundle: MarkDodPrepBundle,
  fetched: MarkDodFetchBundle,
): Promise<MarkDodClaudeVerifyResult> {
  'use step';
  const impl = await import('@/lib/workflows/phases/mark-dod-impl');
  const { getJob } = await import('@/lib/jobs/job-storage');
  const job = getJob(bundle.jobId);
  return impl.readMarkDodVerificationResult(verifyJobId, bundle, job, fetched);
}

async function applyAndFinalizeStep(
  bundle: MarkDodPrepBundle,
  fetched: MarkDodFetchBundle,
  verify: MarkDodClaudeVerifyResult,
  branchSwitch: MarkDodBranchSwitch,
): Promise<MarkDodResult> {
  'use step';
  const impl = await import('@/lib/workflows/phases/mark-dod-impl');
  if (verify.terminal) return verify.terminal;
  const { getJob } = await import('@/lib/jobs/job-storage');
  const job = getJob(bundle.jobId);
  return impl.applyAndFinalizeMarkDod(bundle, job, fetched, verify, branchSwitch);
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  if (!jobId) return;
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'mark-dod-phase');
}

async function finalizeReleaseDirectlyStep(
  releaseJobId: string,
  exitCode: number,
): Promise<void> {
  'use step';
  try {
    const { getJob } = await import('@/lib/jobs/job-storage');
    const { finalizeReleaseJob } = await import('@/lib/jobs/lifecycle');
    const release = getJob(releaseJobId);
    if (release && release.kind === 'release' && release.finishedAt == null) {
      await finalizeReleaseJob(release, exitCode);
    }
  } catch (err) {
    console.error('[mark-dod-phase] failed to finalize release directly:', err);
  }
}
