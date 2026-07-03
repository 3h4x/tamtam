import { mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { invalidateProject } from '@/lib/shared/gh-status';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig, setProjectPushResult } from '@/lib/scheduling/scheduling';
import { currentParent } from '@/lib/jobs/parent-context';
import { createJob, getJob, listJobs, markDone, updateJob } from '@/lib/jobs/job-storage';
import {
  finishJobCancellation,
  JobCancelledError,
  registerJobCancellation,
  throwIfJobCancelled,
} from '@/lib/jobs/cancellation';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import {
  generateCommitMessage,
  findIssueContext,
  deriveIssueContextFromBranch,
  isGitIndexLockError,
  runGitIndexLockRetry,
  stageProjectChangesWithIndexLockRetry,
} from './start-commit';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { createGenericPR, createIssuePR } from './pr-create';
import { decidePrContext } from './pr-context';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { isRetryableRemoteRefRejection } from './push-rejection';
import { pauseProject } from './pause-project';
import type { JobData } from '@/lib/jobs/types';

/**
 * Distinguish a genuine merge conflict during a pull/rebase (which needs a human
 * to resolve) from other rebase failures (e.g. a read-only `.git` in a
 * restricted sandbox, or a network error). Only true conflicts should pause the
 * project; transient/environmental failures surface as a normal error and get
 * retried on the next push cycle.
 */
export function isRebaseConflict(output: string): boolean {
  const o = output.toLowerCase();
  return (
    o.includes('conflict')
    || o.includes('could not apply')
    || o.includes('resolve all conflicts')
    || o.includes('fix conflicts and then run')
    || o.includes('needs merge')
    || o.includes('patch failed')
  );
}

export type PushResult =
  | { ok: true; jobId?: string; commitSha: string; message: string; prUrl?: string; prNumber?: number; prRepo?: string }
  | { ok: false; jobId?: string; status: number; detail: string; blockingJobId?: string };

// One-line outcome for the push job's History row title — the opened PR, the
// pushed sha, or the no-op message — instead of a generic "Push" label.
function summarizePush(result: Extract<PushResult, { ok: true }>): string {
  if (result.prUrl) return result.prNumber ? `Opened PR #${result.prNumber}` : (result.message || 'Pushed');
  if (result.commitSha) return `Pushed as ${result.commitSha}`;
  return result.message || 'Pushed';
}

const RETRIABLE_RELEASE_STEP_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak']);

function latestStartedJob(jobs: JobData[], matches: (job: JobData) => boolean): JobData | undefined {
  let latest: JobData | undefined;
  for (const job of jobs) {
    if (!matches(job)) continue;
    if (!latest || (job.startedAt || 0) > (latest.startedAt || 0)) latest = job;
  }
  return latest;
}

export type ReleaseRetryValidation =
  | { ok: true; parentJobId: string | null; releaseLinkedRetry: boolean }
  | { ok: false; status: number; detail: string };

export async function validateReleaseLinkedRetry(
  projectName: string,
  parentJobId?: string | null,
): Promise<ReleaseRetryValidation> {
  const normalizedParentJobId = parentJobId ?? null;
  if (!normalizedParentJobId) {
    return { ok: true, parentJobId: null, releaseLinkedRetry: false };
  }

  const lock = await getLock(projectName);
  const release = getJob(normalizedParentJobId);
  if (
    !lock
    || lock.lockedByJobId !== normalizedParentJobId
    || !(await isLockOwnedByActiveRelease(projectName))
    || !release
    || release.project !== projectName
    || release.kind !== 'release'
    || release.finishedAt !== null
  ) {
    return {
      ok: false,
      status: 409,
      detail: `Release-linked push retry is only allowed for the active release on ${projectName}`,
    };
  }

  const latestReleaseStep = latestStartedJob(
    listJobs(),
    (job) =>
      job.project === projectName
      && job.releaseId === normalizedParentJobId
      && RETRIABLE_RELEASE_STEP_KINDS.has(job.kind),
  );

  if (
    !latestReleaseStep
    || latestReleaseStep.kind !== 'push'
    || latestReleaseStep.finishedAt === null
    || latestReleaseStep.exitCode === null
    || latestReleaseStep.exitCode === 0
  ) {
    return {
      ok: false,
      status: 409,
      detail: `Release-linked push retry is only allowed when the latest step is a failed push for ${projectName}`,
    };
  }

  return { ok: true, parentJobId: normalizedParentJobId, releaseLinkedRetry: true };
}

/**
 * Validator for push retries from two UI paths:
 *   - active release push retry while the release lock is still held
 *   - History "Retry push" on the latest finished release whose last step was push
 */
export async function validateReleaseLinkedPushRetry(
  projectName: string,
  parentJobId?: string | null,
): Promise<ReleaseRetryValidation> {
  const normalizedParentJobId = parentJobId ?? null;
  if (!normalizedParentJobId) {
    return { ok: true, parentJobId: null, releaseLinkedRetry: false };
  }

  const release = getJob(normalizedParentJobId);
  if (!release || release.project !== projectName || release.kind !== 'release') {
    return { ok: false, status: 404, detail: `Release ${normalizedParentJobId} not found for ${projectName}` };
  }

  const lock = await getLock(projectName);
  if (lock && release.finishedAt === null && lock.lockedByJobId === normalizedParentJobId) {
    return validateReleaseLinkedRetry(projectName, normalizedParentJobId);
  }
  if (lock) {
    return {
      ok: false,
      status: 409,
      detail: `Pipeline is running for ${projectName} — wait for it to finish before retrying the push`,
    };
  }
  if (release.finishedAt === null) {
    return {
      ok: false,
      status: 409,
      detail: `Retry push is only available for the active release or latest finished release on ${projectName}`,
    };
  }

  const jobs = listJobs();
  const latestRelease = latestStartedJob(jobs, (j) => j.project === projectName && j.kind === 'release');
  if (!latestRelease || latestRelease.id !== normalizedParentJobId) {
    return {
      ok: false,
      status: 409,
      detail: `Retry push is only available for the latest release on ${projectName}`,
    };
  }

  const latestStep = latestStartedJob(
    jobs,
    (j) =>
      j.project === projectName
      && j.releaseId === normalizedParentJobId
      && RETRIABLE_RELEASE_STEP_KINDS.has(j.kind),
  );
  if (
    !latestStep
    || latestStep.kind !== 'push'
    || latestStep.finishedAt === null
    || latestStep.exitCode === null
    || latestStep.exitCode === 0
  ) {
    return {
      ok: false,
      status: 409,
      detail: `Retry push is only allowed when the latest step on the release is a failed push for ${projectName}`,
    };
  }
  return { ok: true, parentJobId: normalizedParentJobId, releaseLinkedRetry: true };
}

/**
 * Looser validator for the History "Retry commit" button on a finished
 * release whose last pipeline step was a failed commit. The strict
 * `validateReleaseLinkedRetry` rejects this case (lock released, release
 * finished, last step is commit-not-push), but a user-driven retry on the
 * latest release of a project is exactly the workflow we want to support:
 * file changes from the prior fix are still on disk; the user wants a fresh
 * commit attempt linked back to the trace of the original release.
 *
 * Rules:
 *   - release must exist + belong to project + be the *latest* release for it
 *   - latest pipeline step on that release must be a failed commit
 *   - no active pipeline lock (a release in flight blocks the retry — wait)
 */
export async function validateReleaseLinkedCommitRetry(
  projectName: string,
  parentJobId?: string | null,
): Promise<ReleaseRetryValidation> {
  const normalizedParentJobId = parentJobId ?? null;
  if (!normalizedParentJobId) {
    return { ok: true, parentJobId: null, releaseLinkedRetry: false };
  }
  const release = getJob(normalizedParentJobId);
  if (!release || release.project !== projectName || release.kind !== 'release') {
    return { ok: false, status: 404, detail: `Release ${normalizedParentJobId} not found for ${projectName}` };
  }
  // Reject when a pipeline is running — let it finish before retrying.
  const lock = await getLock(projectName);
  if (lock && release.finishedAt === null && lock.lockedByJobId === normalizedParentJobId) {
    // Same active release — fall through to the strict validator's behaviour.
    return validateReleaseLinkedRetry(projectName, normalizedParentJobId);
  }
  if (lock) {
    return {
      ok: false,
      status: 409,
      detail: `Pipeline is running for ${projectName} — wait for it to finish before retrying the commit`,
    };
  }
  // Must be the project's most recent release.
  const jobs = listJobs();
  const latestRelease = latestStartedJob(jobs, (j) => j.project === projectName && j.kind === 'release');
  if (!latestRelease || latestRelease.id !== normalizedParentJobId) {
    return {
      ok: false,
      status: 409,
      detail: `Retry commit is only available for the latest release on ${projectName}`,
    };
  }
  // Latest pipeline step on this release must be a failed commit.
  const latestStep = latestStartedJob(
    jobs,
    (j) =>
      j.project === projectName
      && j.releaseId === normalizedParentJobId
      && RETRIABLE_RELEASE_STEP_KINDS.has(j.kind),
  );
  if (
    !latestStep
    || latestStep.kind !== 'commit'
    || latestStep.finishedAt === null
    || latestStep.exitCode === null
    || latestStep.exitCode === 0
  ) {
    return {
      ok: false,
      status: 409,
      detail: `Retry commit is only allowed when the latest step on the release is a failed commit for ${projectName}`,
    };
  }
  return { ok: true, parentJobId: normalizedParentJobId, releaseLinkedRetry: true };
}

export async function startProjectPush(
  projectName: string,
  options: { parentJobId?: string | null } = {},
): Promise<PushResult> {
  const parentJobId = options.parentJobId ?? currentParent();
  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  const underRelease = await isLockOwnedByActiveRelease(projectName);
  if (!underRelease) {
    const lock = await getLock(projectName);
    if (lock) {
      setProjectPushResult(projectName, `Pipeline is running for ${projectName}`);
      return { ok: false, status: 409, detail: `Pipeline is running for ${projectName}`, blockingJobId: lock.lockedByJobId };
    }
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    setProjectPushResult(projectName, 'project not found');
    return { ok: false, status: 404, detail: 'project not found' };
  }
  const gate = await checkCliStartGate('start a push', { parentJobId });
  if (!gate.ok) {
    setProjectPushResult(projectName, gate.detail);
    return gate;
  }

  // Track every push attempt as a job so it appears in run history with a log
  // file the user can inspect — same pattern as tests/review.
  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });
  // Stamp issue context on the push job so downstream hooks can pick it up
  // without re-scanning run jobs (avoids context loss on intervening runs).
  const earlyIssueCtx =
    (await findIssueContext(projectName, projPath)) ?? (await deriveIssueContextFromBranch(projPath));
  const job = createJob(
    projectName, 'push', process.pid, '',
    undefined, undefined, undefined,
    earlyIssueCtx?.number ?? null,
    earlyIssueCtx?.repo ?? null,
    earlyIssueCtx?.title ?? null,
    options.parentJobId,
  );
  job.provider = gate.provider;
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);
  const signal = registerJobCancellation(job.id);

  // Acquire pipeline lock — skip under parent release lock.
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-push] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  const append = (s: string) => {
    try { appendRedactedFileSync(logPath, s); } catch {}
  };
  append(`# push start — ${new Date().toISOString()}\n# repo: ${projPath}\n`);

  try {
    const result = await runPush(projectName, projPath, append, earlyIssueCtx, false, gate.provider, job, signal);
    try {
      setProjectPushResult(projectName, result.ok ? null : result.detail);
    } catch {}
    if (result.ok) {
      invalidateProject(projectName);
      clearProjectDataCache();
      job.workSummary = summarizePush(result);
      append(`\n# push ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
      if (result.prUrl) {
        job.contextMeta = JSON.stringify({ prUrl: result.prUrl, prNumber: result.prNumber, prRepo: result.prRepo });
        updateJob(job);
      }
    } else {
      append(`\n# push failed (${result.status})\n${result.detail}\n`);
    }

    await markDone(job, result.ok ? 0 : 1);
    return { ...result, jobId: job.id };
  } catch (error) {
    if (!(error instanceof JobCancelledError)) throw error;
    append('\n# push cancelled\n');
    const exitCode = job.cancelRequestedExitCode ?? -3;
    if (exitCode === -3 && job.abortedAt == null) job.abortedAt = Date.now() / 1000;
    await markDone(job, exitCode);
    return { ok: false, status: 499, detail: 'push cancelled', jobId: job.id };
  } finally {
    finishJobCancellation(job.id);
  }
}

// Fire-and-forget variant: creates the job, runs push in the
// background, and returns the job ID so callers can stream output.
// Standalone/manual launches are push-only. Explicit release-linked retries
// must preserve the full push semantics so PR creation/context propagation
// still happen before downstream hooks decide whether to start pr-wait/merge.
export async function launchProjectPush(
  projectName: string,
  options: { parentJobId?: string | null } = {},
): Promise<{ jobId: string } | { error: string; status?: number }> {
  const requestedParentJobId = options.parentJobId ?? currentParent();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { error: 'project not found' };
  const retryValidation = await validateReleaseLinkedPushRetry(projectName, requestedParentJobId);
  if (!retryValidation.ok) {
    return { error: retryValidation.detail, status: retryValidation.status };
  }
  const parentJobId = retryValidation.parentJobId;
  const releaseLinkedRetry = retryValidation.releaseLinkedRetry;

  // If a release pipeline is in flight, the auto-chain will push at the right
  // step. Letting the manual "Push" button race the release lets push run in
  // parallel with test/review/fix and clobbers ordering.
  const lock = await getLock(projectName);
  const underParentRelease = !!parentJobId
    && !!lock
    && lock.lockedByJobId === parentJobId
    && await isLockOwnedByActiveRelease(projectName);
  if (lock && !underParentRelease) {
    return { error: `Pipeline is running for ${projectName} — wait for it to finish before pushing manually`, status: 409 };
  }

  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });
  const job = createJob(projectName, 'push', process.pid, '', undefined, undefined, undefined, undefined, undefined, undefined, parentJobId);
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);
  const signal = registerJobCancellation(job.id);

  const append = (s: string) => {
    try { appendRedactedFileSync(logPath, s); } catch {}
  };
  append(`# push start — ${new Date().toISOString()}\n# repo: ${projPath}\n`);

  // Run async in background — do not await
  ;(async () => {
    const gate = await checkCliStartGate('start a push', { parentJobId });
    if (!gate.ok) {
      append(`\n# push blocked (${gate.status})\n${gate.detail}\n`);
      try { setProjectPushResult(projectName, gate.detail); } catch {}
      await markDone(job, 1);
      finishJobCancellation(job.id);
      return;
    }
    job.provider = gate.provider;
    updateJob(job);
    // Pre-check above guarantees no active pipeline; acquire the lock for this
    // standalone push so a concurrent release/agent can't sneak in mid-push.
    // The pre-check + async acquire has a TOCTOU window — if a release started
    // in between, acquireLock returns { acquired: false } (it does not throw).
    // Bail out in that case so we don't race the release on the same worktree.
    if (!underParentRelease) {
      try {
        const lockResult = await acquireLock(projectName, job.id);
        if (!lockResult.acquired) {
          const detail = `Pipeline is running for ${projectName} — wait for it to finish before pushing manually`;
          append(`\n# push aborted — ${detail}\n`);
          try { setProjectPushResult(projectName, detail); } catch {}
          await markDone(job, 1);
          finishJobCancellation(job.id);
          return;
        }
      } catch (e) {
        console.log(`[launch-push] failed to acquire pipeline lock for ${projectName}:`, e);
        append(`\n# push aborted — failed to acquire pipeline lock\n`);
        await markDone(job, 1);
        finishJobCancellation(job.id);
        return;
      }
    }

    try {
      const result = await runPush(
        projectName,
        projPath,
        append,
        releaseLinkedRetry ? undefined : null,
        !releaseLinkedRetry,
        gate.provider,
        job,
        signal,
      );
      try { setProjectPushResult(projectName, result.ok ? null : result.detail); } catch {}
      if (result.ok) {
        invalidateProject(projectName);
        clearProjectDataCache();
        job.workSummary = summarizePush(result);
        append(`\n# push ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
        if (result.prUrl) {
          job.contextMeta = JSON.stringify({ prUrl: result.prUrl, prNumber: result.prNumber, prRepo: result.prRepo });
          updateJob(job);
        }
      } else {
        append(`\n# push failed (${result.status})\n${result.detail}\n`);
      }
      await markDone(job, result.ok ? 0 : 1);
    } catch (error) {
      if (!(error instanceof JobCancelledError)) throw error;
      append('\n# push cancelled\n');
      const exitCode = job.cancelRequestedExitCode ?? -3;
      if (exitCode === -3 && job.abortedAt == null) job.abortedAt = Date.now() / 1000;
      await markDone(job, exitCode);
    } finally {
      finishJobCancellation(job.id);
    }
  })().catch(async (error) => {
    console.error(`[push] background push failed for ${projectName}:`, error);
    append(`\n# push launcher error\n${error instanceof Error ? error.message : String(error)}\n`);
    await markDone(job, 1);
    finishJobCancellation(job.id);
  });

  return { jobId: job.id };
}

// Push-only: just push existing commits, with the same set-upstream fallback
// used by the release pipeline. Shared by runPush(pushOnly) and the
// Create-PR endpoint so both get the same resilience semantics.
export type PushHookFailure = 'pre-push-tests' | 'pre-push-other' | null;

export async function pushCurrentBranch(
  projPath: string,
  log: (s: string) => void = () => {},
  options: { noVerify?: boolean; projectName?: string } = {},
  signal?: AbortSignal,
): Promise<
  | { ok: true; commitSha: string }
  | { ok: false; detail: string; hookFailure: PushHookFailure }
> {
  const PUSH_TIMEOUT = 25 * 60 * 1000;
  const baseArgs = options.noVerify ? ['--no-verify'] : [];
  const tryPush = async (extraArgs: string[] = []) => {
    const args = ['-C', projPath, 'push', ...baseArgs, ...extraArgs];
    // Log just the args that follow `push` (skip the `-C <path> push` prefix
    // we always prepend), otherwise the line reads `$ git push push …`.
    const displayArgs = [...baseArgs, ...extraArgs];
    log(`\n$ git push${displayArgs.length ? ' ' + displayArgs.join(' ') : ''}\n`);
    const r = await exec('git', args, { timeout: PUSH_TIMEOUT, killProcessGroup: true, signal });
    if (r.stdout) log(r.stdout);
    if (r.stderr) log(r.stderr);
    return r;
  };
  const fetchAndRebase = async (branch: string, reason: string) => {
    log(`\n# ${reason} — fetching origin/${branch} before rebasing\n`);
    const fetchR = await exec('git', ['-C', projPath, 'fetch', '--quiet', 'origin', branch], {
      timeout: PUSH_TIMEOUT,
      killProcessGroup: true,
      signal,
    });
    if (fetchR.stdout) log(fetchR.stdout);
    if (fetchR.stderr) log(fetchR.stderr);
    if (fetchR.exitCode !== 0) {
      const detail = (fetchR.stderr.trim() || fetchR.stdout.trim() || 'fetch failed').slice(0, 2000);
      return { ok: false as const, detail: `Fetch failed before push: ${detail}` };
    }

    const rebaseR = await exec('git', ['-C', projPath, 'rebase', 'FETCH_HEAD'], {
      timeout: PUSH_TIMEOUT,
      killProcessGroup: true,
      signal,
    });
    if (rebaseR.stdout) log(rebaseR.stdout);
    if (rebaseR.stderr) log(rebaseR.stderr);
    if (rebaseR.exitCode !== 0) {
      const detail = (rebaseR.stderr.trim() || rebaseR.stdout.trim() || 'rebase failed').slice(0, 2000);
      const combined = `${rebaseR.stderr}\n${rebaseR.stdout}`;
      if (isRebaseConflict(combined)) {
        log(`\n# merge conflict during ${reason} — aborting rebase${options.projectName ? ` and pausing ${options.projectName}` : ''}\n`);
        const abortR = await exec('git', ['-C', projPath, 'rebase', '--abort'], {
          timeout: 30000,
          killProcessGroup: true,
          signal,
        });
        if (abortR.stdout) log(abortR.stdout);
        if (abortR.stderr) log(abortR.stderr);
        let pauseNote = '';
        if (options.projectName) {
          const paused = await pauseProject(
            options.projectName,
            'Push blocked — pull --rebase hit a merge conflict on the default branch. Resolve the conflict locally, then resume.',
          );
          pauseNote = paused
            ? ` ${options.projectName} paused for manual resolution.`
            : ` Failed to pause ${options.projectName}; manual resolution is still required.`;
          log(paused
            ? `# ${options.projectName} paused — resolve the conflict locally, then resume from Settings\n`
            : `# WARNING: failed to pause ${options.projectName} after merge conflict\n`);
        }
        return {
          ok: false as const,
          detail: `Merge conflict during ${reason}; rebase aborted.${pauseNote} ${detail}`.trim(),
        };
      }
      return { ok: false as const, detail: `Rebase failed before push: ${detail}` };
    }

    log(`\n# rebase succeeded — retrying push\n`);
    return { ok: true as const };
  };
  let pushR = await tryPush();
  let currentBranch: string | null = null;
  let setUpstreamBranch: string | null = null;
  if (pushR.exitCode !== 0 && (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream'))) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000, signal });
    currentBranch = branchR.stdout.trim() || null;
    if (currentBranch) {
      setUpstreamBranch = currentBranch;
      pushR = await tryPush(['-u', 'origin', currentBranch]);
    }
  }
  if (pushR.exitCode !== 0 && isRetryableRemoteRefRejection(`${pushR.stderr}\n${pushR.stdout}`)) {
    const branchR = currentBranch
      ? null
      : await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000, signal });
    const branch = currentBranch ?? branchR?.stdout.trim() ?? '';
    if (!branch) {
      return {
        ok: false,
        detail: 'Push failed because the remote moved, but the current branch could not be resolved for recovery',
        hookFailure: null,
      };
    }
    const rebased = await fetchAndRebase(branch, 'remote has new commits (stale tracking)');
    if (!rebased.ok) {
      return { ok: false, detail: rebased.detail, hookFailure: null };
    }
    pushR = await tryPush(setUpstreamBranch ? ['-u', 'origin', setUpstreamBranch] : []);
  }
  if (pushR.exitCode !== 0) {
    // Detect hook failures against the FULL combined output — vitest/jest dump
    // thousands of passing-test lines before the failure summary, so a head-only
    // slice misses the signal and we mis-classify the failure as non-retryable.
    const fullOutput = `${pushR.stderr}\n${pushR.stdout}`;
    const lowerFull = fullOutput.toLowerCase();
    const looksLikeHook =
      lowerFull.includes('pre-push') ||
      lowerFull.includes('failed tests') ||
      lowerFull.includes('failed |') ||
      lowerFull.includes('test files') ||
      lowerFull.includes('lint') ||
      lowerFull.includes('eslint') ||
      lowerFull.includes('typecheck') ||
      lowerFull.includes('tsc') ||
      / fail /i.test(fullOutput) ||
      lowerFull.includes('hook declined');
    const isTestFailure =
      lowerFull.includes('failed tests') ||
      lowerFull.includes('assertionerror') ||
      /\bfail\b.*\.test\./i.test(fullOutput) ||
      /test files\s+\d+ failed/i.test(fullOutput) ||
      lowerFull.includes('test files') ||
      lowerFull.includes('vitest') ||
      lowerFull.includes('jest');
    const hookFailure: PushHookFailure = looksLikeHook
      ? (isTestFailure ? 'pre-push-tests' : 'pre-push-other')
      : null;
    // Truncate the detail toward the END of the output — that's where the
    // failure summary lives. A head-truncated detail is just noise.
    const rawDetail = pushR.stderr.trim() || pushR.stdout.trim() || `git push exited ${pushR.exitCode}`;
    const detail = rawDetail.length > 2000 ? `…(truncated)\n${rawDetail.slice(-2000)}` : rawDetail;
    return { ok: false, detail: `Push failed: ${detail}`, hookFailure };
  }
  const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000, signal });
  return { ok: true, commitSha: shaR.exitCode === 0 ? shaR.stdout.trim() : '' };
}


async function runPush(
  projectName: string,
  projPath: string,
  log: (s: string) => void,
  issueCtx?: { number: number; repo: string; title: string } | null,
  pushOnly?: boolean,
  provider?: string,
  job?: { id: string; abortedAt?: number | null; cancelRequestedExitCode?: number | null },
  signal?: AbortSignal,
): Promise<PushResult> {
  const execStep = async (
    cmd: string,
    args: string[],
    options?: Parameters<typeof exec>[2],
  ) => {
    if (job) throwIfJobCancelled(job, signal);
    const result = await exec(cmd, args, {
      ...options,
      signal,
      abortProcessTree: cmd === 'git' ? true : options?.abortProcessTree,
    });
    if (job) throwIfJobCancelled(job, signal);
    return result;
  };

  // Shared handling for a failed pull/rebase before push. A real merge conflict
  // can't be auto-resolved, so abort the half-finished rebase to leave the
  // worktree clean and pause the project — that stops the scheduler from
  // hammering a push that can never succeed until a human resolves it. Other
  // (non-conflict) rebase failures surface as a normal error and are retried.
  const failedRebase = async (
    rebaseR: { exitCode: number; stdout: string; stderr: string },
    label: string,
  ): Promise<PushResult> => {
    const combined = `${rebaseR.stderr}\n${rebaseR.stdout}`;
    const detail = (rebaseR.stderr.trim() || rebaseR.stdout.trim() || 'rebase failed').slice(0, 2000);
    if (isRebaseConflict(combined)) {
      log(`\n# merge conflict during ${label} — aborting rebase and pausing ${projectName}\n`);
      const abortR = await execStep('git', ['-C', projPath, 'rebase', '--abort'], { timeout: 30000 });
      if (abortR.stdout) log(abortR.stdout);
      if (abortR.stderr) log(abortR.stderr);
      const paused = await pauseProject(
        projectName,
        `Push blocked — a merge conflict during ${label} on the default branch needs manual resolution. Resolve locally, then resume.`,
      );
      log(paused
        ? `# ${projectName} paused — resolve the conflict locally, then resume from Settings\n`
        : `# WARNING: failed to pause ${projectName} after merge conflict\n`);
      return {
        ok: false,
        status: 409,
        detail: `Merge conflict during ${label}; ${projectName} paused for manual resolution. ${detail}`,
      };
    }
    return { ok: false, status: 409, detail: `Rebase failed before push: ${detail}` };
  };

  // pushOnly: skip all staging/committing/PR logic — just push existing commits.
  if (pushOnly) {
    const r = await pushCurrentBranch(projPath, log, { projectName }, signal);
    if (!r.ok) return { ok: false, status: 502, detail: r.detail };
    return { ok: true, commitSha: r.commitSha, message: 'pushed' };
  }

  // Resolve issue context if not passed in (e.g. called from launchProjectPush).
  if (issueCtx === undefined) issueCtx = await findIssueContext(projectName, projPath);
  // Fallback: if no run-job stamp matched, derive from the current branch name.
  // Why: keeps the "Closes #N" PR body when the issue-tagged run is older than
  // the 30-min recency window in findIssueContext (e.g. release re-runs after
  // manual edits) but the worktree is still on fix/issue-N-…
  if (!issueCtx) {
    const fromBranch = await deriveIssueContextFromBranch(projPath, signal);
    if (fromBranch) issueCtx = fromBranch;
  }

  // Check if there's anything to push. `rev-list @{u}..HEAD` fails with a
  // non-zero exit when @{u} is unresolvable — which happens on a fresh
  // branch that was never pushed, OR when the remote ref was deleted after
  // a squash-merge (classic zombie branch). Silently treating that as
  // "No changes to push" can maroon real commits on the branch. Distinguish:
  //   - exit 0, count > 0 → push
  //   - exit 0, count 0   → genuinely no changes
  //   - exit != 0         → no upstream; fall through to tryPush, which
  //                         retries with `--set-upstream` via the existing
  //                         fallback below when push fails with
  //                         "no upstream" / "set-upstream" stderr.
  const aheadR = await execStep('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
  log(`\n$ git rev-list --count @{u}..HEAD\n${aheadR.stdout}`);
  const ahead = parseInt(aheadR.stdout.trim(), 10);
  const hasUpstream = aheadR.exitCode === 0;
  if (hasUpstream && (!aheadR.stdout.trim() || isNaN(ahead) || ahead === 0)) {
    // Nothing to push, but we may still owe a PR. A prior push attempt can
    // have shipped the branch (or the user pushed manually) and left the
    // pipeline mid-state; without this fallback, the issue branch stays
    // unmerged forever because mark-dod runs without a linked PR.
    const shaR = await execStep('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
    const commitSha = shaR.exitCode === 0 ? shaR.stdout.trim() : '';
    if (issueCtx) {
      log('\n# no commits to push but issue branch detected — ensuring PR exists\n');
      const prUrl = await createIssuePR(projPath, log, issueCtx, signal, job?.id ?? null);
      if (prUrl) {
        const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10) || undefined;
        return { ok: true, commitSha, message: `PR created: ${prUrl}`, prUrl, prNumber, prRepo: issueCtx.repo };
      }
      return { ok: true, commitSha, message: 'No changes to push (PR creation skipped or failed — see log)' };
    }
    const prDecision = await decidePrContext(projPath, signal);
    if (prDecision.shouldOpenPr) {
      log(`\n# no commits to push but non-default branch — ensuring PR exists: ${prDecision.reason}\n`);
      const prResult = await createGenericPR(projPath, log, signal);
      if (prResult) {
        const prNumber = parseInt(prResult.prUrl.split('/').pop() ?? '0', 10) || undefined;
        return { ok: true, commitSha, message: `PR created: ${prResult.prUrl}`, prUrl: prResult.prUrl, prNumber, prRepo: prResult.prRepo };
      }
    }
    return { ok: true, commitSha, message: 'No changes to push' };
  }
  if (!hasUpstream) {
    // Guard against an empty HEAD (brand-new repo with no commits yet).
    const hasCommitsR = await execStep('git', ['-C', projPath, 'rev-list', '--count', 'HEAD'], { timeout: 5000 });
    const hasCommits = hasCommitsR.exitCode === 0 && (parseInt(hasCommitsR.stdout.trim(), 10) || 0) > 0;
    if (!hasCommits) {
      return { ok: true, commitSha: '', message: 'No changes to push' };
    }
    log(`\n# no upstream configured — push will --set-upstream origin <branch>\n`);
  }

  // Pre-push hooks that run a full CI pipeline can take 15-20 minutes.
  // killProcessGroup ensures the entire hook process tree (build + worker
  // processes) is killed if the timeout fires, preventing orphans.
  const PUSH_TIMEOUT = 25 * 60 * 1000; // 25 minutes

  const tryPush = async (extraArgs: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const args = ['-C', projPath, 'push', ...extraArgs];
    log(`\n$ git push${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}\n`);
    const r = await execStep('git', args, { timeout: PUSH_TIMEOUT, killProcessGroup: true });
    if (r.stdout) log(r.stdout);
    if (r.stderr) log(r.stderr);
    return r;
  };

  // Auto-rebase if behind remote to prevent non-fast-forward rejection
  const branchStatusR = await execStep('git', ['-C', projPath, 'status', '--porcelain=v2', '--branch'], { timeout: 5000 });
  const abLine = branchStatusR.stdout.split('\n').find(l => l.startsWith('# branch.ab '));
  const behind = abLine ? parseInt(abLine.match(/-(\d+)/)?.[1] ?? '0', 10) : 0;
  if (behind > 0) {
    log(`\n# ${behind} commit(s) behind remote — rebasing before push\n`);
    const rebaseR = await execStep('git', ['-C', projPath, 'pull', '--rebase'], { timeout: PUSH_TIMEOUT, killProcessGroup: true });
    if (rebaseR.stdout) log(rebaseR.stdout);
    if (rebaseR.stderr) log(rebaseR.stderr);
    if (rebaseR.exitCode !== 0) {
      return await failedRebase(rebaseR, 'pull --rebase before push');
    }
    log(`\n# rebase succeeded\n`);
  }

  let pushR = await tryPush();
  let setUpstreamBranch: string | null = null;

  // If no upstream branch is set, detect current branch and set it.
  if (pushR.exitCode !== 0 && (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream'))) {
    const branchR = await execStep('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const branch = branchR.stdout.trim();
    if (branch) {
      setUpstreamBranch = branch;
      pushR = await tryPush(['-u', 'origin', branch]);
    }
  }

  // Push rejected because the remote has commits the local clone doesn't know about
  // (stale tracking info — the pre-push behind-check missed it). Pull --rebase and retry.
  // Covers the standard "fetch first" / "Updates were rejected" messages plus
  // GitHub's ref-lock race ("cannot lock ref … is at X but expected Y"). Avoid
  // matching generic "[remote rejected]" output; Git uses that for protected
  // branches, permissions, and other server-side denials that a rebase cannot fix.
  if (pushR.exitCode !== 0 && isRetryableRemoteRefRejection(`${pushR.stderr}\n${pushR.stdout}`)) {
    log(`\n# remote has new commits (stale tracking) — rebasing before retry\n`);
    const rebaseArgs = setUpstreamBranch
      ? ['-C', projPath, 'pull', '--rebase', 'origin', setUpstreamBranch]
      : ['-C', projPath, 'pull', '--rebase'];
    const rebaseR = await execStep('git', rebaseArgs, { timeout: PUSH_TIMEOUT, killProcessGroup: true });
    if (rebaseR.stdout) log(rebaseR.stdout);
    if (rebaseR.stderr) log(rebaseR.stderr);
    if (rebaseR.exitCode === 0) {
      log(`\n# rebase succeeded — retrying push\n`);
      pushR = await tryPush(setUpstreamBranch ? ['-u', 'origin', setUpstreamBranch] : []);
    } else {
      return await failedRebase(rebaseR, 'rebase after remote rejection');
    }
  }

  // Pre-push hook may have left new uncommitted changes on disk.
  // Stage and commit just those changes ("revisiting just new changes"), then retry once.
  if (pushR.exitCode !== 0) {
    const hookChangesR = await execStep('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
    const hookHasChanges = !!hookChangesR.stdout.trim();
    if (hookHasChanges) {
      log(`\n# pre-push hook left new changes — committing delta\n`);
      const stageR = await stageProjectChangesWithIndexLockRetry(projPath, execStep, log);
      if (stageR.exitCode !== 0) {
        const detail = (stageR.stderr.trim() || stageR.stdout.trim() || `git add exited ${stageR.exitCode}`).slice(0, 2000);
        return { ok: false, status: 500, detail: `Stage failed after pre-push hook changes: ${detail}` };
      }
      const fixMsg = await generateCommitMessage(projPath, projectName, provider, signal);
      log(`# fix commit message: ${fixMsg}\n\n$ git commit -m "${fixMsg}"\n`);
      const fixCommitR = await runGitIndexLockRetry(
        projPath,
        'git commit',
        () => execStep('git', ['-C', projPath, 'commit', '-m', fixMsg], { timeout: 30000 }),
        log,
      );
      if (fixCommitR.stdout) log(fixCommitR.stdout);
      if (fixCommitR.stderr) log(fixCommitR.stderr);
      if (fixCommitR.exitCode === 0 || fixCommitR.stdout.includes('nothing to commit')) {
        log(`\n# retrying push after hook fix commit\n`);
        pushR = await tryPush();
      } else if (isGitIndexLockError(fixCommitR)) {
        const detail = (fixCommitR.stderr.trim() || fixCommitR.stdout.trim() || `git commit exited ${fixCommitR.exitCode}`).slice(0, 2000);
        return { ok: false, status: 500, detail: `Commit failed after pre-push hook changes: ${detail}` };
      }
    }
  }

  if (pushR.exitCode !== 0) {
    const detail = (pushR.stderr.trim() || pushR.stdout.trim() || `git push exited ${pushR.exitCode}`).slice(0, 2000);
    return { ok: false, status: 502, detail: `Push failed: ${detail}` };
  }

  const shaR = await execStep('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
  const commitSha = shaR.exitCode === 0 ? shaR.stdout.trim() : '';

  if (issueCtx) {
    const prUrl = await createIssuePR(projPath, log, issueCtx, signal, job?.id ?? null);
    // Stay on the issue branch until the PR merges, regardless of whether
    // auto-merge is enabled. The user iterates on the branch (more fixes,
    // more pushes); switching to main now strands them with conflicts. The
    // post-merge return-to-main is handled by start-pr-wait when auto-merge
    // is on, or by an explicit user "Back to main" action when it's off.
    log(`\n# staying on issue branch until PR is merged\n`);
    clearProjectDataCache();
    if (prUrl) {
      const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10) || undefined;
      return { ok: true, commitSha, message: `PR created: ${prUrl}`, prUrl, prNumber, prRepo: issueCtx.repo };
    }
    return { ok: true, commitSha, message: 'pushed (PR creation failed — see log)' };
  }

  const prDecision = await decidePrContext(projPath, signal);
  if (prDecision.shouldOpenPr) {
    log(`\n# branch-derived PR decision: ${prDecision.reason}\n`);
    const prResult = await createGenericPR(projPath, log, signal);
    if (prResult) {
      const prNumber = parseInt(prResult.prUrl.split('/').pop() ?? '0', 10) || undefined;
      // Stay on the feature branch until the PR merges. start-pr-wait handles
      // post-merge return-to-main when auto-merge is on; otherwise the user
      // returns manually.
      log(`\n# staying on feature branch until PR is merged\n`);
      return { ok: true, commitSha, message: `PR created: ${prResult.prUrl}`, prUrl: prResult.prUrl, prNumber, prRepo: prResult.prRepo };
    }
    if (prResult === false) {
      return { ok: true, commitSha, message: 'pushed' };
    }
    return { ok: true, commitSha, message: 'pushed (PR creation failed — see log)' };
  }

  log(`\n# branch-derived direct push: ${prDecision.reason}\n`);
  return { ok: true, commitSha, message: 'pushed' };
}
