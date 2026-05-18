// Soak phase workflow. Runs after `pr-wait` merges a release PR. Watches
// the default branch's CI on the merge commit for a configurable window and
// — on failure — opens (and optionally auto-merges) a revert PR.
//
// The phase is no-op when the project's `post_merge_watch_minutes` is 0 or
// the prior pr-wait did not actually merge. In both cases the workflow
// returns `{ ok: true, skipped: true }` and the orchestrator finalises the
// release normally.
//
// Each side-effectful operation (gh poll, revert PR, finalize) lives in a
// `'use step'` body so its result is cached and replay-safe.

import { sleep } from 'workflow';
import { safeStartOrchestrator } from '@/lib/workflows/safe-start-orchestrator';
import type { CiRun, SoakContextMeta } from '@/lib/pipeline/start-soak';

export type SoakPhaseResult =
  | {
      ok: true;
      skipped: true;
      reason: 'disabled' | 'no_merge_sha';
    }
  | {
      ok: true;
      jobId: string;
      verdict: 'pass' | 'fail' | 'timeout';
      revertPrUrl: string | null;
      autoMerged: boolean;
    }
  | {
      ok: false;
      reason: 'launch_failed';
      error: string;
    };

interface SoakPrepInput {
  /** Resolved by the orchestrator from gh + project config — passed through
   *  so the soak phase does not duplicate the gh round-trips. */
  mergeSha: string;
  defaultBranch: string;
  watchMinutes: number;
  autoRevert: boolean;
  prNumber: number;
  prRepo: string;
  prUrl: string;
}

interface SoakPrepResult {
  ok: boolean;
  skipped?: true;
  reason?: 'disabled' | 'no_merge_sha' | 'launch_failed';
  error?: string;
  jobId?: string;
  projPath?: string;
  meta?: SoakContextMeta;
  deadlineAt?: number;
}

export async function releaseSoakPhaseWorkflow(
  projectName: string,
  prep: SoakPrepInput,
  releaseJobId?: string,
): Promise<SoakPhaseResult> {
  'use workflow';

  const prepared = await prepareSoakStep({ ...prep, projectName, releaseJobId });
  if (!prepared.ok) {
    if (prepared.skipped) {
      // Skip path: pretend the soak phase finalised cleanly and let the
      // orchestrator close the release via the dispatched tick.
      if (releaseJobId) {
        await finalizeReleaseDirectlyStep(releaseJobId, 0);
      }
      const reason = prepared.reason === 'no_merge_sha' ? 'no_merge_sha' : 'disabled';
      return { ok: true, skipped: true, reason };
    }
    return { ok: false, reason: 'launch_failed', error: prepared.error ?? 'unknown' };
  }

  const { jobId, meta, projPath, deadlineAt } = prepared;
  if (!jobId || !meta || !projPath || !deadlineAt) {
    return { ok: false, reason: 'launch_failed', error: 'missing prep fields' };
  }

  let verdict: 'pass' | 'fail' | 'timeout' = 'timeout';
  let failedRuns: CiRun[] = [];

  while (true) {
    const poll = await pollDefaultBranchCiStep(jobId, projPath, meta, deadlineAt);
    if (poll.expired) { verdict = 'timeout'; break; }
    if (poll.classification === 'fail') {
      verdict = 'fail';
      failedRuns = poll.failed;
      break;
    }
    if (poll.classification === 'pass') {
      verdict = 'pass';
      break;
    }
    // `pending` / `none` — keep polling until the deadline.
    await sleep(poll.intervalMs);
  }

  let revertPrUrl: string | null = null;
  let autoMerged = false;
  if (verdict === 'fail') {
    const revert = await openRevertPrStep(jobId, projPath, meta, failedRuns);
    revertPrUrl = revert.prUrl ?? null;
    if (revert.ok && revert.prUrl && meta.autoRevert) {
      autoMerged = await autoMergeRevertStep(jobId, projPath, meta.prRepo, revert.prUrl);
    }
    await notifyRevertStep(jobId, projectName, meta, failedRuns, revertPrUrl);
  }

  const exitCode = verdict === 'fail' ? 1 : 0;
  await finalizeSoakStep(jobId, exitCode, verdict);

  // soak is a terminal phase — re-dispatch the orchestrator so it sees
  // decideNextPhase=done and finalises the release meta-job.
  if (releaseJobId) {
    await dispatchOrchestratorTickStep(jobId, projectName, releaseJobId);
  }

  return { ok: true, jobId, verdict, revertPrUrl, autoMerged };
}

// ── Steps ────────────────────────────────────────────────────────────────────

interface PrepareSoakStepInput extends SoakPrepInput {
  projectName: string;
  releaseJobId?: string;
}

async function prepareSoakStep(input: PrepareSoakStepInput): Promise<SoakPrepResult> {
  'use step';
  const { resolveProjectPath } = await import('@/lib/shared/project-data');
  const { launchSoak } = await import('@/lib/pipeline/start-soak');

  const projPath = resolveProjectPath(input.projectName);
  if (!projPath) return { ok: false, error: 'project not found', reason: 'launch_failed' };

  if (!input.watchMinutes || input.watchMinutes <= 0) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }
  if (!input.mergeSha) {
    return { ok: false, skipped: true, reason: 'no_merge_sha' };
  }

  const meta: SoakContextMeta = {
    mergeSha: input.mergeSha,
    prRepo: input.prRepo,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    defaultBranch: input.defaultBranch,
    watchMinutes: input.watchMinutes,
    autoRevert: input.autoRevert,
  };

  // Wrap createJob in runWithParent so the soak row inherits release_id.
  let launched;
  if (input.releaseJobId) {
    const { runWithParent } = await import('@/lib/jobs/parent-context');
    launched = await runWithParent(input.releaseJobId, () =>
      launchSoak({ projectName: input.projectName, meta }),
    );
  } else {
    launched = launchSoak({ projectName: input.projectName, meta });
  }
  if (!launched.ok || !launched.jobId) {
    return { ok: false, error: launched.error ?? 'launch failed', reason: 'launch_failed' };
  }

  return {
    ok: true,
    jobId: launched.jobId,
    projPath,
    meta,
    deadlineAt: Date.now() + meta.watchMinutes * 60_000,
  };
}

interface PollDefaultBranchResult {
  expired: boolean;
  classification: 'pass' | 'fail' | 'pending' | 'none';
  failed: CiRun[];
  intervalMs: number;
}

async function pollDefaultBranchCiStep(
  jobId: string,
  projPath: string,
  meta: SoakContextMeta,
  deadlineAt: number,
): Promise<PollDefaultBranchResult> {
  'use step';
  const {
    appendSoakLog,
    classifyDefaultBranchCi,
    queryDefaultBranchCi,
    SOAK_DEFAULT_POLL_INTERVAL_MS,
  } = await import('@/lib/pipeline/start-soak');
  const intervalMs = SOAK_DEFAULT_POLL_INTERVAL_MS;

  if (Date.now() >= deadlineAt) {
    appendSoakLog(jobId, `\n# soak window elapsed — no failures observed\n`);
    return { expired: true, classification: 'none', failed: [], intervalMs };
  }
  const runs = await queryDefaultBranchCi({
    projPath,
    repo: meta.prRepo,
    defaultBranch: meta.defaultBranch,
    mergeSha: meta.mergeSha,
  });
  const verdict = classifyDefaultBranchCi(runs);
  appendSoakLog(
    jobId,
    `\n# soak poll: ${runs.length} run(s), verdict=${verdict.kind}\n`,
  );
  if (verdict.kind === 'fail') {
    return { expired: false, classification: 'fail', failed: verdict.failed, intervalMs };
  }
  if (verdict.kind === 'pass') {
    return { expired: false, classification: 'pass', failed: [], intervalMs };
  }
  return { expired: false, classification: verdict.kind === 'pending' ? 'pending' : 'none', failed: [], intervalMs };
}

async function openRevertPrStep(
  jobId: string,
  projPath: string,
  meta: SoakContextMeta,
  failed: CiRun[],
): Promise<{ ok: boolean; prUrl?: string }> {
  'use step';
  const { openRevertPr, appendSoakLog } = await import('@/lib/pipeline/start-soak');
  appendSoakLog(jobId, `\n# soak: opening revert PR for ${meta.mergeSha}\n`);
  const r = await openRevertPr({
    projPath,
    repo: meta.prRepo,
    defaultBranch: meta.defaultBranch,
    meta,
    failed,
    log: (s) => appendSoakLog(jobId, s),
  });
  if (r.ok && r.prUrl) appendSoakLog(jobId, `\n# soak: revert PR opened ${r.prUrl}\n`);
  return { ok: r.ok, prUrl: r.prUrl };
}

async function autoMergeRevertStep(
  jobId: string,
  projPath: string,
  repo: string,
  prUrl: string,
): Promise<boolean> {
  'use step';
  const { autoMergeRevertPr, appendSoakLog } = await import('@/lib/pipeline/start-soak');
  appendSoakLog(jobId, `\n# soak: enabling auto-merge for revert PR\n`);
  try {
    await autoMergeRevertPr(projPath, repo, prUrl, (s) => appendSoakLog(jobId, s));
    return true;
  } catch (err) {
    appendSoakLog(jobId, `\n# soak: auto-merge errored: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

async function notifyRevertStep(
  jobId: string,
  projectName: string,
  meta: SoakContextMeta,
  failed: CiRun[],
  revertPrUrl: string | null,
): Promise<void> {
  'use step';
  const { notifyPostMergeRevert } = await import('@/lib/pipeline/start-soak');
  await notifyPostMergeRevert({
    jobId,
    projectName,
    meta,
    failed,
    revertPrUrl,
    reason: 'default_branch_ci_failed',
  });
}

async function finalizeSoakStep(
  jobId: string,
  exitCode: number,
  verdict: string,
): Promise<void> {
  'use step';
  const { appendSoakLog, finalizeSoakJob } = await import('@/lib/pipeline/start-soak');
  appendSoakLog(jobId, `\n# soak finished — verdict ${verdict} (exit ${exitCode})\n`);
  await finalizeSoakJob(jobId, exitCode);
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'soak-phase');
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
    console.error('[soak-phase] failed to finalize release directly:', err);
  }
}
