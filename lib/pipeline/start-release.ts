import { mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { isProjectArchived, isProjectPaused } from '@/lib/shared/enabled-projects';
import { startProjectTest, detectTestCommand } from './start-test';
import { startProjectReview } from './start-review';
import { startProjectPush } from './start-push';
import { startProjectCommit } from './start-commit';
import { listJobs, probeJobStatus, createJob, updateJob, getJob, runWithParent } from '@/lib/jobs/job-storage';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig, getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { acquireLock, releaseLock, reassignLock } from './pipeline-lock';
import { findIssueContext, isIssueContextCompatibleWithCurrentBranch } from './start-commit';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { getReleaseReadinessFailure } from '@/lib/shared/readiness';
import { hasFreshLgtm, hasLocalCommitsAhead } from './release-state';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import type { IssueContext } from './release-context';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { computeReleaseDeadlineAt } from './release-timeout';

const RELEASE_PIPELINE_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod', 'release']);

async function isReleasePipelineRunning(projectName: string): Promise<boolean> {
  const candidates = listJobs().filter(
    (j) => j.project === projectName && j.finishedAt === null && RELEASE_PIPELINE_KINDS.has(j.kind)
  );
  for (const j of candidates) {
    if ((await probeJobStatus(j)) === 'running') return true;
  }
  return false;
}

export type ReleaseResult =
  | { ok: true; step: 'test' | 'review' | 'commit' | 'push'; jobId?: string; releaseJobId?: string; message: string }
  | { ok: true; status: 'queued'; step?: undefined; jobId?: undefined; releaseJobId?: undefined; message: string; blockingJobId?: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string; retryable?: boolean };

export interface StartReleaseOptions {
  queueIfBlocked?: boolean;
  sourceJobId?: string;
}

async function resolveReleaseIssueContext(
  projectName: string,
  projPath: string,
  sourceJob: ReturnType<typeof getJob>,
): Promise<IssueContext | null> {
  if (sourceJob?.project === projectName && sourceJob.ghIssueNumber != null) {
    const sourceIssue = {
      number: sourceJob.ghIssueNumber,
      repo: sourceJob.ghIssueRepo ?? '',
      title: sourceJob.ghIssueTitle ?? '',
    };
    return (await isIssueContextCompatibleWithCurrentBranch(sourceIssue, projPath))
      ? sourceIssue
      : null;
  }

  const hasIssueTaggedRun = listJobs().some(
    (job) => job.project === projectName && job.kind === 'run' && job.ghIssueNumber != null,
  );
  return hasIssueTaggedRun ? await findIssueContext(projectName, projPath) : null;
}

// Create a "release" meta-job DB row. Workflow orchestration owns the
// release's lifecycle now; there's no separate process to spawn.
//
// Historical context: this function used to write a bash script and start it
// under PM2 as a per-release monitor that polled the log for the
// `# release finished` marker. With workflow-driven releases that monitor is
// dead weight — the orchestrator workflow waits for steps directly. The
// release job's `pid` is set to `process.pid` so probeJobStatus's
// inline-job logic treats it the same way it treats any other in-process
// kind (push/commit/mark-dod/pr-wait).
async function createReleaseJob(
  projectName: string,
  projectPath: string,
  parentJobId?: string | null,
  issueContext?: IssueContext | null,
): Promise<{ id: string; releaseId: string; logPath: string } | null> {
  try {
    const { logDir } = getImproveConfig();
    mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

    const job = createJob(projectName, 'release', process.pid, '', undefined, undefined, undefined, undefined, undefined, undefined, parentJobId);
    job.releaseDeadlineAt = computeReleaseDeadlineAt(projectPath);
    const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
    job.logPath = logPath;
    if (issueContext) {
      job.ghIssueNumber = issueContext.number;
      job.ghIssueRepo = issueContext.repo;
      job.ghIssueTitle = issueContext.title;
    }
    // Release job identifies itself: every child step created while this
    // release is active will auto-inherit this id as its releaseId.
    job.releaseId = job.id;

    // Record the triggering job (parent agent/terminal run) in the log header
    // for traceability.
    let triggerLine = '';
    if (job.parentJobId) {
      const trigger = getJob(job.parentJobId);
      if (trigger && trigger.project === projectName) {
        triggerLine = `# triggered by: ${trigger.kind} ${trigger.id}\n`;
      }
    }

    appendRedactedFileSync(logPath, `# release start — ${new Date().toISOString()}\n# project: ${projectName}\n${triggerLine}`);
    updateJob(job);
    return { id: job.id, releaseId: job.id, logPath };
  } catch {
    return null;
  }
}

async function hasChanges(projPath: string): Promise<boolean> {
  const r = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (r.exitCode !== 0) return false;
  return r.stdout.split('\n').some((l) => l.trim());
}

/**
 * Pluggable release pipeline entry point.
 *
 * Flow: tests (if configured) → review → push. Subsequent steps are chained via
 * completion hooks in `job-storage.runCompletionHooks` — this helper only
 * starts the first step. Caller must ensure `auto_push_enabled` is set for the
 * chaining to continue automatically.
 *
 * Decision order:
 *  1. If no changes and no unpushed commits → nothing to release
 *  2. If a test command is configured/detected → start tests
 *  3. If there are changes or unpushed commits → start review
 */
async function queueRelease(projectName: string, blockingJobId?: string): Promise<ReleaseResult> {
  const { setPendingRelease } = await import('./pending-release');
  setPendingRelease(projectName);
  return {
    ok: true,
    status: 'queued',
    message: `Release queued for ${projectName}`,
    blockingJobId,
  };
}

export async function startRelease(projectName: string, options: StartReleaseOptions = {}): Promise<ReleaseResult> {
  let projPath = resolveProjectPath(projectName);
  // First-lookup miss can happen when startRelease runs inside the workflow
  // runtime's module realm right after a Postgres world re-init — the
  // realm's `_projectsCache` hasn't been populated yet even though the DB
  // row exists. Refresh the cache once and retry before declaring the
  // project gone. Drops the silent-failure mode where pending-release
  // drains lost releases to a "project not found" race.
  if (!projPath) {
    try {
      const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
      await refreshProjectsCacheSync();
      projPath = resolveProjectPath(projectName);
    } catch { /* fall through to 404 */ }
  }
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };
  if (isProjectArchived(projectName)) {
    return { ok: false, status: 409, detail: 'project archived' };
  }
  if (isProjectPaused(projectName)) {
    return { ok: false, status: 409, detail: 'project paused' };
  }
  const sourceJob = options.sourceJobId ? getJob(options.sourceJobId) : null;
  const parentJobId = sourceJob?.project === projectName ? sourceJob.id : null;
  const gate = await checkCliStartGate('start a release', { parentJobId });
  if (!gate.ok) {
    // For budget-blocked releases, enqueue so the periodic drain picks it up
    // when the 5h window resets. For pause, the existing resume hook drains.
    if (gate.status === 429) {
      const { setPendingRelease } = await import('./pending-release');
      setPendingRelease(projectName);
    }
    if (options.queueIfBlocked) return queueRelease(projectName);
    return gate;
  }
  const readinessFailure = await getReleaseReadinessFailure(projectName, gate.provider);
  if (readinessFailure) {
    return {
      ok: false,
      status: 503,
      detail: `Release readiness check failed (${readinessFailure.name}): ${readinessFailure.message}`,
    };
  }

  const blockingJob = await findBlockingRunningJob(
    projectName,
    (job) => !RELEASE_PIPELINE_KINDS.has(job.kind),
  );
  if (blockingJob) {
    if (options.queueIfBlocked) return queueRelease(projectName, blockingJob.id);
    return {
      ok: false,
      status: 409,
      detail: `Job '${blockingJob.kind}' is already running for ${projectName} (job ${blockingJob.id})`,
      blockingJobId: blockingJob.id,
    };
  }

  if (await isReleasePipelineRunning(projectName)) {
    if (options.queueIfBlocked) return queueRelease(projectName);
    return { ok: false, status: 409, detail: `Release pipeline already running for ${projectName}` };
  }

  const issueContext = await resolveReleaseIssueContext(projectName, projPath, sourceJob);

  const changes = await hasChanges(projPath);
  const unpushed = await hasLocalCommitsAhead(projPath);
  if (!changes && !unpushed) {
    return { ok: false, status: 400, detail: 'Nothing to release — no changes and no unpushed commits' };
  }

  // Acquire the lock before creating the release job so that if we can't get
  // it, we return immediately without creating any DB row. The old approach
  // (pre-check → create job → acquire) left a race window where a concurrent
  // caller could sneak in and cause the freshly-created job to be immediately
  // marked done with exit 1, producing a confusing "release blocked" entry.
  //
  // We acquire with a placeholder ID first, create the job, then re-acquire
  // with the real job ID (onConflictDoUpdate overwrites in place).
  const placeholderId = `${projectName}-release-pending`;
  const earlyLock = await acquireLock(projectName, placeholderId);
  if (!earlyLock.acquired) {
    if (options.queueIfBlocked) return queueRelease(projectName, earlyLock.blockingJobId);
    return { ok: false, status: 409, detail: `Pipeline already running for ${projectName}`, blockingJobId: earlyLock.blockingJobId };
  }

  const release = await createReleaseJob(projectName, projPath, parentJobId, issueContext);
  if (!release) {
    await releaseLock(projectName, placeholderId);
    return { ok: false, status: 500, detail: 'Failed to create release job', retryable: true };
  }
  const releaseJobId = release.id;

  // Update lock from placeholder to real job ID. Force-overwrite — `acquireLock`
  // would see the placeholder as an existing holder (within self-heal grace)
  // and refuse, leaking the release row.
  reassignLock(projectName, releaseJobId);

  const releaseJob = getJob(releaseJobId);
  if (releaseJob) {
    releaseJob.provider = gate.provider;
    updateJob(releaseJob);
  }

  // Fast-path: the working tree already has a valid LGTM review (hash
  // unchanged since markReviewed). Re-running tests and review would be
  // busywork — skip straight to commit & push. This keeps Release as a
  // single button while still being smart about what to do.
  const skipToPush = await hasFreshLgtm(projectName, projPath);

  const testCmd = await detectTestCommand(projPath, projectName);
  const testsDisabled = !!(await getProjectTestConfig(projectName))?.testsDisabled;

  // First step's parent is the release meta job, not whatever triggered the
  // release (agent run, manual click). Switching the AsyncLocalStorage parent
  // here makes the chain read as: agent → release → test → review → commit → push.
  //
  // If the first step fails to start (or throws), finalize the release row and
  // release the pipeline lock here — otherwise the release sits in `running`
  // with no children until either boot recovery or the 4h bash-monitor timeout
  // reaps it.
  const result: ReleaseResult = await Promise.resolve(runWithParent(releaseJobId, async (): Promise<ReleaseResult> => {
    // No uncommitted changes — run tests first (if configured + not disabled) to
    // verify committed code before review/push. Completion hook handles test→review
    // when local commits are ahead of upstream.
    if (!changes) {
      if (testCmd && !testsDisabled) {
        const r = await startProjectTest(projectName);
        if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
        return { ok: true, step: 'test' as const, jobId: r.jobId, releaseJobId, message: `Running tests (${r.testCmd})` };
      }
      const freshLgtm = await hasFreshLgtm(projectName, projPath);
      if (freshLgtm) {
        const r = await startProjectPush(projectName);
        if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
        return { ok: true, step: 'push' as const, releaseJobId, message: r.message };
      }
      const reviewDisabled = !!(await getProjectTestConfig(projectName))?.reviewDisabled;
      if (reviewDisabled) {
        const r = await startProjectPush(projectName);
        if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
        return { ok: true, step: 'push' as const, releaseJobId, message: r.message };
      }
      const r = await startProjectReview(projectName);
      if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
      return { ok: true, step: 'review' as const, jobId: r.jobId, releaseJobId, message: 'Running review' };
    }

    // Fresh LGTM and there are uncommitted changes — commit them first, then push.
    if (skipToPush) {
      const r = await startProjectCommit(projectName);
      if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
      return { ok: true, step: 'push' as const, releaseJobId, message: r.message };
    }

    // Has uncommitted changes — run tests first (if configured), then review.
    if (testCmd && !testsDisabled) {
      const r = await startProjectTest(projectName);
      if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
      return { ok: true, step: 'test' as const, jobId: r.jobId, releaseJobId, message: `Running tests (${r.testCmd})` };
    }

    // If review is disabled per-project, short-circuit to commit — treat the
    // agent's own prompt as the review step. No autoCommit gating needed: we're
    // already inside an explicit release, which implies commit intent (same reason
    // job-storage.ts's completion hook lets `inRelease` bypass autoCommitEnabled).
    const reviewDisabled = !!(await getProjectTestConfig(projectName))?.reviewDisabled;
    if (reviewDisabled) {
      const r = await startProjectCommit(projectName);
      if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
      return { ok: true, step: 'commit' as const, releaseJobId, message: r.message };
    }

    const r = await startProjectReview(projectName);
    if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
    return { ok: true, step: 'review' as const, jobId: r.jobId, releaseJobId, message: 'Running review' };
  })).catch((err: unknown): ReleaseResult => ({
    ok: false,
    status: 500,
    detail: `release first-step launch threw: ${err instanceof Error ? err.message : String(err)}`,
  }));

  if (!result.ok) {
    // First step failed to start (or threw). Without cleanup the release row
    // stays `running`, the pipeline lock stays held, and the PM2 bash monitor
    // keeps polling for `# release finished` until it times out (~4h). Append
    // the finalizer marker so the monitor exits cleanly, mark the release
    // done, and release the lock — mirroring boot recovery.
    try {
      const releaseJob = getJob(releaseJobId);
      if (releaseJob && releaseJob.finishedAt === null) {
        const { finalizeReleaseJob } = await import('@/lib/jobs/lifecycle');
        await finalizeReleaseJob(releaseJob, 1);
      } else {
        await releaseLock(projectName, releaseJobId);
      }
    } catch (e) {
      console.log(`[release] cleanup after first-step failure threw for ${projectName}:`, e);
      try { await releaseLock(projectName, releaseJobId); } catch {}
    }
  }
  return result;
}

// Returns true when the project's most recent finished review is LGTM AND
// the working-tree hash still matches the one markReviewed captured. That's
// the signal that re-running tests + review would add nothing.
