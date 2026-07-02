// pr-wait phase workflow. Polls PR CI status until merge / fail / timeout,
// then squash-merges, switches back to the default branch, and runs the
// post-merge DoD verification.
//
// The polling loop lives inside the workflow body and uses workflow-native
// `sleep` between iterations. Workflow runtime owns durability: a restart
// mid-poll resumes from the event log.
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
      reason: 'merged' | 'pr_closed' | 'checks_failed' | 'conflict' | 'merge_permanent' | 'risky_diff' | 'switch_failed' | 'timeout';
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
  let terminalReason: 'merged' | 'pr_closed' | 'checks_failed' | 'conflict' | 'merge_permanent' | 'risky_diff' | 'switch_failed' | 'timeout' = 'timeout';

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

      const risky = await riskyDiffStep(jobId, prep.projPath, prNumber, prRepo);
      if (risky) { terminalReason = 'risky_diff'; break; }

      const mergeResult = await attemptMergeStep(jobId, prep.projPath, prNumber, prRepo);
      if (mergeResult.ok) { merged = true; terminalReason = 'merged'; break; }
      if (mergeResult.permanent) { terminalReason = 'merge_permanent'; break; }
      // transient — fall through to sleep + retry
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (!merged) {
    await finalizePrWaitStep(jobId, 1, terminalReason, prNumber, prRepo);
    return { ok: true, jobId, finished: true, merged: false, reason: terminalReason, exitCode: 1 };
  }

  const switched = await switchToDefaultStep(jobId, prep.projPath);
  if (!switched.ok) {
    await finalizePrWaitStep(jobId, 1, 'switch_failed', prNumber, prRepo);
    return { ok: true, jobId, finished: true, merged: true, reason: 'switch_failed', exitCode: 1 };
  }

  await runPostMergeMarkDodStep(jobId, projectName, prNumber, prRepo);

  await finalizePrWaitStep(jobId, 0, 'merged', prNumber, prRepo);
  return { ok: true, jobId, finished: true, merged: true, reason: 'merged', exitCode: 0 };
}

async function riskyDiffStep(jobId: string, projPath: string, prNumber: number, prRepo: string): Promise<boolean> {
  'use step';
  const { riskyPrDiffFiles } = await import('@/lib/security/pr-branch-execution');
  const { appendLogForJob } = await import('@/lib/workflows/phases/pr-wait-log');
  const files = riskyPrDiffFiles(projPath, prNumber, prRepo);
  if (files.length === 0) return false;
  appendLogForJob(
    jobId,
    `\n# refusing auto-merge: PR diff touches high-risk execution files\n${files.map((f) => `- ${f}`).join('\n')}\n`,
  );
  return true;
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
  const { appendLogForJob, findIssueTargetForPostMergeDod } = await import('@/lib/workflows/phases/pr-wait-log');
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
  prNumber: number,
  prRepo: string,
): Promise<void> {
  'use step';
  const { getJob, markDone, updateJob } = await import('@/lib/jobs/job-storage');
  const { appendLogForJob } = await import('@/lib/workflows/phases/pr-wait-log');
  appendLogForJob(jobId, `\n# pr-wait done — ${reason}\n`);
  const job = getJob(jobId);
  if (job) {
    // Stamp the terminal reason on the job so the inbox can explain why an
    // unmerged PR is still open (e.g. `risky_diff` deferred to a human)
    // without parsing the log. Merged into the existing {prNumber,…} context.
    if (exitCode !== 0) {
      try {
        const meta = job.contextMeta ? JSON.parse(job.contextMeta) : {};
        const merged = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : {};
        merged.prWaitReason = reason;
        job.contextMeta = JSON.stringify(merged);
        updateJob(job);
      } catch { /* non-fatal — reason still lands in the log */ }
    }
    await markDone(job, exitCode);
  }

  // Auto-dispatch fix-ci when remote CI checks fail on an open PR. Without
  // this the release ends at a broken PR and no further work happens until
  // a human clicks "Fix CI"; release automation keeps driving toward merge.
  // fix-ci's existing release-after-fix-ci hook chains a new release on
  // success, closing the loop.
  if (reason === 'checks_failed' && job) {
    try {
      // fix-ci reads ci_failed_url from gh_status; populate it first using
      // the first failing check URL from gh pr view. Without this the API
      // returns "No failed CI URL found" and the release stalls.
      await populateGhStatusFromPrChecks(job.project, prNumber, prRepo);
      const base = process.env.TAMTAM_BASE_URL || 'http://localhost:1337';
      const url = `${base}/api/projects/by-project/${encodeURIComponent(job.project)}/fix-ci`;
      const res = await fetch(url, { method: 'POST' });
      const detail = await res.text().catch(() => '');
      appendLogForJob(jobId, `\n# auto fix-ci dispatch — ${res.status} ${detail.slice(0, 200)}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLogForJob(jobId, `\n# auto fix-ci dispatch failed: ${msg}\n`);
    }
  }
}

/** Best-effort: read the first failing check URL from `gh pr view` and
 *  upsert it into `gh_status.ci_failed_url` so the existing fix-ci route
 *  can consume it. Silently swallows errors — fix-ci itself will surface
 *  the "No failed CI URL found" 400 if this fails. */
async function populateGhStatusFromPrChecks(projectName: string, prNumber: number, prRepo: string): Promise<void> {
  'use step';
  const { resolveProjectPath } = await import('@/lib/shared/project-data');
  const { exec } = await import('@/lib/shared/shell');
  const { db, schema } = await import('@/lib/db');
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return;
  let parsed: { statusCheckRollup?: Array<PrCheckRollupItem> } = {};
  try {
    const r = await exec(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', prRepo, '--json', 'statusCheckRollup'],
      { cwd: projPath, timeout: 15000 },
    );
    if (r.exitCode !== 0 || !r.stdout) return;
    parsed = JSON.parse(r.stdout);
  } catch { return; }
  const failedUrl = findFailedPrCheckUrl(parsed.statusCheckRollup ?? []);
  if (!failedUrl) return;
  try {
    const fetchedAt = new Date().toISOString();
    await db.insert(schema.ghStatus)
      .values({ project: projectName, ciFailedUrl: failedUrl, fetchedAt })
      .onConflictDoUpdate({ target: schema.ghStatus.project, set: { ciFailedUrl: failedUrl, fetchedAt } })
      .execute();
  } catch { /* table absent in some test envs */ }
}

type PrCheckRollupItem = {
  __typename?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  state?: string | null;
  status?: string | null;
  targetUrl?: string | null;
  url?: string | null;
};

function findFailedPrCheckUrl(checks: PrCheckRollupItem[]): string | null {
  for (const check of checks) {
    const url = firstNonEmptyString(check.detailsUrl, check.targetUrl, check.url);
    if (!url) continue;

    if (check.__typename === 'StatusContext' || (check.state !== undefined && check.status === undefined)) {
      const state = (check.state ?? '').toUpperCase();
      if (state !== 'PENDING' && state !== 'EXPECTED' && state !== 'SUCCESS' && state !== '') {
        return url;
      }
      continue;
    }

    if ((check.status ?? '').toUpperCase() !== 'COMPLETED') continue;
    const conclusion = (check.conclusion ?? '').toUpperCase();
    if (conclusion !== 'SUCCESS' && conclusion !== 'NEUTRAL' && conclusion !== 'SKIPPED') {
      return url;
    }
  }
  return null;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
}
