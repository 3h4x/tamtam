// Soak phase workflow. Runs after `pr-wait` merges a release PR. Watches
// the default branch's CI on the merge commit until it reaches a terminal
// state and — on failure — opens (and optionally auto-merges) a revert PR.
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

/**
 * 90s grace period for the "no CI runs ever appeared" case. Past this point we
 * treat absence as "project doesn't have default-branch CI configured" and pass
 * the soak. Distinct from the `pending` case, which polls forever — see
 * https://github.com/3h4x/tamtam/issues/26#refined-design.
 */
export const SOAK_NO_CHECKS_GRACE_MS = 90_000;

export type SoakPhaseResult =
  | {
      ok: true;
      skipped: true;
      reason: 'disabled' | 'no_merge_sha';
    }
  | {
      ok: true;
      jobId: string;
      verdict: 'pass' | 'fail';
      passReason?: 'ci_passed' | 'no_ci_configured';
      failReason?: 'ci_failed';
      revertPrUrl: string | null;
      autoMerged: boolean;
      projectPaused: boolean;
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

type SoakPrepResult =
  | {
      ok: true;
      jobId: string;
      projPath: string;
      meta: SoakContextMeta;
      /** Wall-clock start of the soak loop. Used only to time the 90s grace for
       *  the "no CI runs ever appeared" case. There is no upper time bound on
       *  pending — soak polls until CI terminates one way or the other. */
      startedAt: number;
    }
  | { ok: false; skipped: true; reason: 'disabled' | 'no_merge_sha' }
  | { ok: false; skipped?: false; reason: 'launch_failed'; error: string };

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
      return { ok: true, skipped: true, reason: prepared.reason };
    }
    return { ok: false, reason: 'launch_failed', error: prepared.error };
  }

  const { jobId, meta, projPath, startedAt } = prepared;

  // Verdict-driven loop. No upper time cap — soak polls until CI terminates.
  //   - pass         → release unlocks normally
  //   - fail         → project paused, revert PR opened
  //   - pending      → keep polling (no timeout)
  //   - none         → keep polling for 90s, then treat as "no CI configured"
  let verdict: 'pass' | 'fail' = 'pass';
  let passReason: 'ci_passed' | 'no_ci_configured' = 'ci_passed';
  let failedRuns: CiRun[] = [];

  while (true) {
    const poll = await pollDefaultBranchCiStep(jobId, projPath, meta);
    if (poll.classification === 'fail') {
      verdict = 'fail';
      failedRuns = poll.failed;
      break;
    }
    if (poll.classification === 'pass') {
      verdict = 'pass';
      passReason = 'ci_passed';
      break;
    }
    if (poll.classification === 'none' && Date.now() - startedAt > SOAK_NO_CHECKS_GRACE_MS) {
      // No CI runs ever appeared on the merge commit. Assume the project has
      // no default-branch CI configured to gate against, and pass.
      verdict = 'pass';
      passReason = 'no_ci_configured';
      break;
    }
    // `pending` (CI in flight) OR `none` within grace — keep polling.
    await sleep(poll.intervalMs);
  }

  let revertPrUrl: string | null = null;
  let autoMerged = false;
  let projectPaused = false;
  let selfHealed = false;
  if (verdict === 'fail') {
    // Self-heal first: when auto fix-ci is enabled, dispatch a bounded fix-ci to
    // REPAIR the red default branch (fix-ci → release-after-fix-ci ships the
    // fix) instead of reverting. Soak's polling is what makes this reliable —
    // it observes the failure whenever it surfaces post-merge, closing the
    // timing gap a sweep "idle on default" trigger can't. Falls back to the
    // revert + pause HITL only when fix-ci is bounded-out / unavailable.
    selfHealed = await maybeAutoFixCiStep(jobId, projectName, failedRuns);
    if (!selfHealed) {
      // Pause project BEFORE opening the revert PR so the gate is already in
      // effect by the time the notification fires.
      projectPaused = await pauseProjectStep(jobId, projectName);
      const revert = await openRevertPrStep(jobId, projPath, meta, failedRuns);
      revertPrUrl = revert.prUrl ?? null;
      if (revert.ok && revert.prUrl && meta.autoRevert) {
        autoMerged = await autoMergeRevertStep(jobId, projPath, meta.prRepo, revert.prUrl);
      }
      await notifyRevertStep(jobId, projectName, meta, failedRuns, revertPrUrl);
    }
  }

  // A self-healed failure exits 0: the release "succeeded" in that the red CI
  // is being repaired by the chained fix-ci → release, not left stranded.
  const exitCode = verdict === 'fail' && !selfHealed ? 1 : 0;
  const verdictLabel = verdict === 'fail'
    ? (selfHealed ? 'fail → auto fix-ci (self-heal)' : 'fail (ci_failed)')
    : `pass (${passReason})`;
  await finalizeSoakStep(jobId, exitCode, verdictLabel);

  // soak is a terminal phase — re-dispatch the orchestrator so it sees
  // decideNextPhase=done and finalises the release meta-job.
  if (releaseJobId) {
    await dispatchOrchestratorTickStep(jobId, projectName, releaseJobId);
  }

  return {
    ok: true,
    jobId,
    verdict,
    ...(verdict === 'pass' ? { passReason } : { failReason: 'ci_failed' as const }),
    revertPrUrl,
    autoMerged,
    projectPaused,
  };
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
    startedAt: Date.now(),
  };
}

interface PollDefaultBranchResult {
  classification: 'pass' | 'fail' | 'pending' | 'none';
  failed: CiRun[];
  intervalMs: number;
}

async function pollDefaultBranchCiStep(
  jobId: string,
  projPath: string,
  meta: SoakContextMeta,
): Promise<PollDefaultBranchResult> {
  'use step';
  const {
    appendSoakLog,
    classifyDefaultBranchCi,
    queryDefaultBranchCi,
    SOAK_DEFAULT_POLL_INTERVAL_MS,
  } = await import('@/lib/pipeline/start-soak');
  const intervalMs = SOAK_DEFAULT_POLL_INTERVAL_MS;

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
    return { classification: 'fail', failed: verdict.failed, intervalMs };
  }
  if (verdict.kind === 'pass') {
    return { classification: 'pass', failed: [], intervalMs };
  }
  return { classification: verdict.kind === 'pending' ? 'pending' : 'none', failed: [], intervalMs };
}

/**
 * On a post-merge CI failure, dispatch a bounded fix-ci to self-heal the red
 * default branch — but only when `auto_fix_ci_on_red_default_branch` is on.
 * Returns true when a fix-ci was dispatched (caller then skips the revert +
 * pause fallback). The bound (one attempt per failing run, capped) lives in
 * `auto-fix-ci-state.ts` so a permanently-broken CI can't loop.
 */
async function maybeAutoFixCiStep(
  jobId: string,
  projectName: string,
  failedRuns: CiRun[],
): Promise<boolean> {
  'use step';
  const { isAutoFixCiOnRedDefaultBranchEnabled } = await import('@/lib/jobs/auto-fix-ci-state');
  if (!(await isAutoFixCiOnRedDefaultBranchEnabled())) return false;
  const { dispatchAutoFixCiForRedDefaultBranch } = await import('@/lib/jobs/dispatch-auto-fix-ci');
  const { appendSoakLog } = await import('@/lib/pipeline/start-soak');
  const failedUrl = failedRuns.find((r) => r.url)?.url ?? null;
  const r = await dispatchAutoFixCiForRedDefaultBranch(projectName, failedUrl, (s) => appendSoakLog(jobId, s));
  return r.dispatched;
}

/**
 * Workflow step wrapper around `pauseProjectForSoakFailure` so the step result
 * is replay-safe (cached by the workflow runtime).
 */
async function pauseProjectStep(jobId: string, projectName: string): Promise<boolean> {
  'use step';
  const { appendSoakLog, pauseProjectForSoakFailure } = await import('@/lib/pipeline/start-soak');
  const ok = await pauseProjectForSoakFailure(projectName);
  appendSoakLog(jobId, ok
    ? `\n# soak: paused project ${projectName} — manual resume required from Settings\n`
    : `\n# soak: failed to pause project ${projectName} (see server logs)\n`);
  return ok;
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
