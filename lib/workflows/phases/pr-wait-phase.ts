// pr-wait phase workflow. Polls PR CI status until merge / fail / timeout,
// then squash-merges, switches back to the default branch, and runs the
// post-merge DoD verification.
//
// The polling loop lives inside the workflow body and uses workflow-native
// `sleep` between iterations. That replaces the previous setTimeout-driven
// runPrWaitLoop, which only survived restarts via the bespoke resumePrWait
// path triggered from `reapAbandonedInlineJobs`. Workflow runtime now owns
// durability: a restart mid-poll resumes from the event log without needing
// the boot-time reaper.
//
// Each side-effectful operation (gh poll, merge, branch switch, mark-dod
// invocation, finalize) is its own `'use step'` so its result is cached and
// replay-safe.
//
// `launchPrWait` / `resumePrWait` in `lib/pipeline/start-pr-wait.ts` are
// kept for the standalone (no-`releaseId`) path — manual "Wait for PR
// merge" triggers that aren't part of a release pipeline still need an
// inline pr-wait job. Release-linked pr-wait runs through this workflow.

import { sleep } from 'workflow';

const POLL_INTERVAL_MS = parseInt(process.env.TAMTAM_PR_WAIT_POLL_MS ?? '', 10) || 30_000;
const TIMEOUT_MS = parseInt(process.env.TAMTAM_PR_WAIT_TIMEOUT_MS ?? '', 10) || 30 * 60 * 1000;
const NO_CHECKS_GRACE_MS = (() => {
  const raw = parseInt(process.env.TAMTAM_PR_WAIT_NO_CHECKS_GRACE_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 90_000;
})();
const NO_CHECKS_MIN_POLLS = (() => {
  const raw = parseInt(process.env.TAMTAM_PR_WAIT_NO_CHECKS_MIN_POLLS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
})();

export type PrWaitPhaseResult =
  | {
      ok: true;
      jobId: string;
      finished: boolean;
      merged: boolean;
      reason: 'merged' | 'pr_closed' | 'checks_failed' | 'conflict' | 'merge_permanent' | 'switch_failed' | 'timeout';
      exitCode: number | null;
    }
  | {
      ok: false;
      reason: 'launch_failed';
      error: string;
    };

type PreparePrWaitResult =
  | { ok: true; jobId: string; projPath: string; logPath: string; deadlineAt: number }
  | { ok: false; error: string };

type PollPrStatusResult =
  | {
      ok: true;
      state: 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN';
      mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
      conclusion: 'pass' | 'fail' | 'pending' | 'none';
      expiredAt: boolean;
      elapsedMs: number;
    }
  | { ok: false };

type MergeStepResult = { ok: true } | { ok: false; permanent: boolean };

type SwitchToDefaultResult = { ok: boolean; branch: string };

export async function releasePrWaitPhaseWorkflow(
  projectName: string,
  prNumber: number,
  prRepo: string,
  prUrl: string,
  releaseJobId?: string,
): Promise<PrWaitPhaseResult> {
  'use workflow';

  const prep = await preparePrWaitStep(projectName, prNumber, prRepo, prUrl, releaseJobId);
  if (!prep.ok) {
    return { ok: false, reason: 'launch_failed', error: prep.error };
  }
  const { jobId } = prep;

  let merged = false;
  let consecutiveNoChecks = 0;
  let terminalReason: 'merged' | 'pr_closed' | 'checks_failed' | 'conflict' | 'merge_permanent' | 'switch_failed' | 'timeout' = 'timeout';

  while (true) {
    const status = await pollPrStatusStep(jobId, prep.projPath, prNumber, prRepo, prep.deadlineAt);
    if (!status.ok) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (status.expiredAt) { terminalReason = 'timeout'; break; }

    if (status.state === 'MERGED') { merged = true; terminalReason = 'merged'; break; }
    if (status.state === 'CLOSED') { terminalReason = 'pr_closed'; break; }

    if (status.conclusion === 'fail') { terminalReason = 'checks_failed'; break; }

    if (status.conclusion === 'pass' || status.conclusion === 'none') {
      if (status.mergeable === 'CONFLICTING') { terminalReason = 'conflict'; break; }

      if (status.mergeable !== 'MERGEABLE') {
        consecutiveNoChecks = 0;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (status.conclusion === 'none') {
        consecutiveNoChecks += 1;
        if (consecutiveNoChecks < NO_CHECKS_MIN_POLLS || status.elapsedMs < NO_CHECKS_GRACE_MS) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
      } else {
        consecutiveNoChecks = 0;
      }

      const mergeResult = await attemptMergeStep(jobId, prep.projPath, prNumber, prRepo);
      if (mergeResult.ok) { merged = true; terminalReason = 'merged'; break; }
      if (mergeResult.permanent) { terminalReason = 'merge_permanent'; break; }
      // transient — fall through to sleep + retry
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (!merged) {
    await finalizePrWaitStep(jobId, 1, terminalReason);
    return { ok: true, jobId, finished: true, merged: false, reason: terminalReason, exitCode: 1 };
  }

  const switched = await switchToDefaultStep(jobId, prep.projPath);
  if (!switched.ok) {
    await finalizePrWaitStep(jobId, 1, 'switch_failed');
    return { ok: true, jobId, finished: true, merged: true, reason: 'switch_failed', exitCode: 1 };
  }

  await runPostMergeMarkDodStep(jobId, projectName, prNumber, prRepo);

  await finalizePrWaitStep(jobId, 0, 'merged');
  return { ok: true, jobId, finished: true, merged: true, reason: 'merged', exitCode: 0 };
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function preparePrWaitStep(
  projectName: string,
  prNumber: number,
  prRepo: string,
  prUrl: string,
  releaseJobId?: string,
): Promise<PreparePrWaitResult> {
  'use step';
  const { mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { resolveProjectPath } = await import('@/lib/shared/project-data');
  const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
  const { createJob, updateJob } = await import('@/lib/jobs/job-storage');
  const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, error: 'project not found' };

  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const meta = JSON.stringify({ prNumber, prRepo, prUrl });
  // Wrap createJob in runWithParent so the pr-wait row inherits release_id
  // and the orchestrator's waitForJobCompletion can find it on the next tick.
  // Without this, release-reconcile sees "release running, no in-flight
  // children" 90s after mark-dod finishes and re-dispatches pr-wait,
  // producing duplicates.
  let job;
  if (releaseJobId) {
    const { runWithParent } = await import('@/lib/jobs/parent-context');
    job = await runWithParent(releaseJobId, () =>
      createJob(projectName, 'pr-wait', 0, '', undefined, meta),
    );
  } else {
    job = createJob(projectName, 'pr-wait', 0, '', undefined, meta);
  }
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);

  try {
    appendRedactedFileSync(logPath, `# pr-wait start — ${new Date().toISOString()}\n# PR #${prNumber} ${prUrl}\n`);
  } catch { /* swallow log-write failures */ }

  return { ok: true, jobId: job.id, projPath, logPath, deadlineAt: Date.now() + TIMEOUT_MS };
}

async function pollPrStatusStep(
  jobId: string,
  projPath: string,
  prNumber: number,
  prRepo: string,
  deadlineAt: number,
): Promise<PollPrStatusResult> {
  'use step';
  const { getPrStatus, checksConclusion } = await import('@/lib/pipeline/start-pr-wait');
  const { appendLogForJob } = await import('@/lib/workflows/phases/pr-wait-log');

  const now = Date.now();
  if (now >= deadlineAt) {
    appendLogForJob(jobId, `\n# pr-wait timed out after ${TIMEOUT_MS / 60000} minutes\n`);
    return { ok: true, state: 'UNKNOWN', mergeable: 'UNKNOWN', conclusion: 'none', expiredAt: true, elapsedMs: TIMEOUT_MS };
  }

  const status = await getPrStatus(projPath, prNumber, prRepo);
  if (!status) {
    appendLogForJob(jobId, `\n# could not fetch PR status — retrying in ${POLL_INTERVAL_MS / 1000}s\n`);
    return { ok: false };
  }

  const conclusion = checksConclusion(status.checks);
  appendLogForJob(
    jobId,
    `\n# PR state: ${status.state} | mergeable: ${status.mergeable} | checks: ${conclusion}\n`,
  );

  return {
    ok: true,
    state: status.state as 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN',
    mergeable: status.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN',
    conclusion,
    expiredAt: false,
    elapsedMs: TIMEOUT_MS - (deadlineAt - now),
  };
}

async function attemptMergeStep(
  jobId: string,
  projPath: string,
  prNumber: number,
  prRepo: string,
): Promise<MergeStepResult> {
  'use step';
  const { doMerge } = await import('@/lib/pipeline/start-pr-wait');
  const { appendLogForJob } = await import('@/lib/workflows/phases/pr-wait-log');
  return doMerge(projPath, prNumber, prRepo, (s) => appendLogForJob(jobId, s));
}

async function switchToDefaultStep(jobId: string, projPath: string): Promise<SwitchToDefaultResult> {
  'use step';
  const { switchToDefault } = await import('@/lib/pipeline/start-pr-wait');
  const { appendLogForJob } = await import('@/lib/workflows/phases/pr-wait-log');
  appendLogForJob(jobId, `\n# switching back to default branch after merge\n`);
  const result = await switchToDefault(projPath, (s) => appendLogForJob(jobId, s));
  if (result.ok) appendLogForJob(jobId, `\n# on ${result.branch}\n`);
  else appendLogForJob(jobId, `\n# ERROR: failed to switch to default branch after merge\n`);
  return result;
}

async function runPostMergeMarkDodStep(
  jobId: string,
  projectName: string,
  prNumber: number,
  prRepo: string,
): Promise<void> {
  'use step';
  const { appendLogForJob } = await import('@/lib/workflows/phases/pr-wait-log');
  const { findIssueTargetForPostMergeDod } = await import('@/lib/workflows/phases/pr-wait-log');
  const { startMarkDod } = await import('@/lib/pipeline/start-mark-dod');

  const issueTarget = findIssueTargetForPostMergeDod(jobId);
  const target = issueTarget
    ? { issueNumber: issueTarget.issueNumber, repo: issueTarget.repo }
    : { prNumber, repo: prRepo };
  appendLogForJob(
    jobId,
    `\n# mark-dod target: ${issueTarget ? `issue #${issueTarget.issueNumber}` : `PR #${prNumber}`}\n`,
  );
  try {
    const md = await startMarkDod(projectName, target);
    if (md.ok) {
      appendLogForJob(
        jobId,
        `\n# mark-dod: ${md.verified}/${md.total} verified${md.changed ? ' (issue updated)' : ''}\n`,
      );
    }
  } catch (e) {
    appendLogForJob(jobId, `\n# mark-dod error: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

async function finalizePrWaitStep(
  jobId: string,
  exitCode: number,
  reason: string,
): Promise<void> {
  'use step';
  const { getJob, markDone } = await import('@/lib/jobs/job-storage');
  const { appendLogForJob } = await import('@/lib/workflows/phases/pr-wait-log');
  appendLogForJob(jobId, `\n# pr-wait done — ${reason}\n`);
  const job = getJob(jobId);
  if (job) await markDone(job, exitCode);
}
