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
  MarkDodResult,
} from '@/lib/workflows/phases/mark-dod-impl';

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

  const prep = await prepareAndFetchStep(projectName, override);
  if (prep.stage === 'terminal') {
    if (releaseJobId) await dispatchOrchestratorTickStep(prep.result.ok ? prep.result.jobId : '', projectName, releaseJobId);
    return toPhaseResult(prep.result);
  }

  const verify = await claudeVerifyStep(prep.bundle, projectName, prep.fetched);

  const final = await applyAndFinalizeStep(prep.bundle, prep.fetched, verify, prep.branchSwitch);
  // mark-dod is a terminal phase. Re-dispatch the orchestrator so it sees
  // decideNextPhase=done and finalizes the release meta-job.
  if (releaseJobId && final.ok) {
    await dispatchOrchestratorTickStep(final.jobId, projectName, releaseJobId);
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
  return { ok: false, reason: 'mark_dod_failed', status: r.status, detail: r.detail };
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function prepareAndFetchStep(
  projectName: string,
  override: MarkDodOverride | undefined,
): Promise<PrepareAndFetchResult> {
  'use step';
  const impl = await import('@/lib/workflows/phases/mark-dod-impl');

  const prep = await impl.prepareMarkDod(projectName, override);
  if ('ok' in prep) {
    return { stage: 'terminal', result: prep };
  }
  const { bundle, job } = prep;

  const fetched = await impl.fetchAndExtractMarkDodCriteria(bundle, job);
  if (fetched.terminal) return { stage: 'terminal', result: fetched.terminal };

  const branchSwitch = await impl.switchBranchForMarkDodVerification(bundle, job);

  return { stage: 'continue', bundle, fetched, branchSwitch };
}

async function claudeVerifyStep(
  bundle: MarkDodPrepBundle,
  projectName: string,
  fetched: MarkDodFetchBundle,
): Promise<MarkDodClaudeVerifyResult> {
  'use step';
  const impl = await import('@/lib/workflows/phases/mark-dod-impl');
  const { getJob } = await import('@/lib/jobs/job-storage');
  const job = getJob(bundle.jobId);
  return impl.runMarkDodClaudeVerification(bundle, job, projectName, fetched);
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
  try {
    const { start } = await import('workflow/api');
    const { releaseOrchestratorWorkflow } = await import('@/lib/workflows/release-orchestrator');
    await start(releaseOrchestratorWorkflow, [jobId, { projectName, parentJobId: releaseJobId }]);
  } catch (err) {
    console.error('[mark-dod-phase] failed to re-dispatch orchestrator:', err);
  }
}
