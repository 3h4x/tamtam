import { mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { isProjectArchived, isProjectPaused } from '@/lib/shared/enabled-projects';
import { startProjectTest, detectTestCommand } from './start-test';
import { startProjectReview } from './start-review';
import { startProjectPush } from './start-push';
import { startProjectCommit } from './start-commit';
import { listJobs, probeJobStatus, createJob, updateJob, getJob, runWithParent, PIPELINE_STEP_KINDS } from '@/lib/jobs/job-storage';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig, getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { acquireLock, releaseLock, reassignLock } from './pipeline-lock';
import { findIssueContext, isIssueContextCompatibleWithCurrentBranch } from './start-commit';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { getReleaseReadinessFailure } from '@/lib/shared/readiness';
import { hasFreshLgtm, hasLocalCommitsAhead } from './release-state';
import { statusHasAnyPath, statusHasOnlyCommittedTamtamMetadataPaths } from '@/lib/pipeline/review-scope';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import type { IssueContext } from './release-context';
import type { JobData } from '@/lib/jobs/types';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { computeReleaseDeadlineAt } from './release-timeout';
import { checkDailySpendCap, type SpendCapExceeded } from './spend-guard';
import { notify } from '@/lib/shared/notifications';
import { getSettings } from '@/lib/shared/config';
import { readCachedGhStatus } from '@/lib/shared/gh-status';
import { shouldBlockReleaseOnRedCi } from './red-ci-gate';

export const RELEASE_PIPELINE_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod', 'release']);

async function isReleasePipelineRunning(projectName: string): Promise<boolean> {
  const candidates = listJobs().filter(
    (j) => j.project === projectName && j.finishedAt === null && RELEASE_PIPELINE_KINDS.has(j.kind)
  );
  for (const j of candidates) {
    if ((await probeJobStatus(j)) === 'running') return true;
  }
  return false;
}

// A pr-wait phase runs with an inline sentinel pid (0), so `probeJobStatus`
// can't recognize it as 'running' — which is why `isReleasePipelineRunning`
// misses it and a second release can start while a PR is already open. Two
// concurrent PRs then race the same base and the loser conflicts (the recurring
// "kurwa konflikty"). Treat any non-finished pr-wait as an open PR holding the
// branch and block new releases until it clears, so master stays frozen from
// issue-work start through merge. Probe-independent (the inline pid defeats
// probing). Bounded by a wall-clock backstop so a permanently-stuck pr-wait
// can't freeze the project forever — the release-timeout watchdog also aborts a
// hung release, which sets `finishedAt` and clears this guard on its own.
const PR_WAIT_SERIALIZE_BACKSTOP_MS = 120 * 60 * 1000;

export function findActivePrWait(
  jobs: JobData[],
  projectName: string,
  nowMs: number = Date.now(),
): JobData | null {
  for (const j of jobs) {
    if (j.project !== projectName || j.kind !== 'pr-wait' || j.finishedAt !== null) continue;
    const startedMs = j.startedAt > 1e12 ? j.startedAt : (j.startedAt ?? 0) * 1000;
    // Skip (don't block) when the pr-wait is past the backstop OR its start time
    // is unparseable (<= 0). A pr-wait we cannot age out must not be allowed to
    // freeze the project's releases forever — that's the exact failure the
    // backstop exists to prevent, so an unknown/zero timestamp falls to the safe
    // side (release allowed) rather than blocking indefinitely.
    if (startedMs <= 0 || nowMs - startedMs > PR_WAIT_SERIALIZE_BACKSTOP_MS) continue;
    return j;
  }
  return null;
}

export type ReleaseResult =
  | { ok: true; step: 'test' | 'review' | 'commit' | 'push'; jobId?: string; releaseJobId?: string; message: string }
  | { ok: true; status: 'queued'; step?: undefined; jobId?: undefined; releaseJobId?: undefined; message: string; blockingJobId?: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string; retryable?: boolean };

export interface StartReleaseOptions {
  queueIfBlocked?: boolean;
  sourceJobId?: string;
  // Set by an explicit operator-initiated release (the UI Release button).
  // Recorded as `trustedLocalChanges` provenance on the release row for
  // trace/audit; no longer changes gate behavior (the PR-branch gate verifies
  // committed authors and never refuses on a dirty working tree).
  operatorInitiated?: boolean;
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
  trustedLocalChanges?: boolean,
): Promise<{ id: string; releaseId: string; logPath: string } | null> {
  try {
    const { logDir } = getImproveConfig();
    mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

    const job = createJob(projectName, 'release', process.pid, '', undefined, undefined, undefined, undefined, undefined, undefined, parentJobId);
    job.releaseDeadlineAt = computeReleaseDeadlineAt(projectPath);
    const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
    job.logPath = logPath;
    // Persist the trusted-local-changes provenance on the release row: this
    // release's uncommitted working-tree delta is the operator's/agent's own
    // work. It's a trace/audit marker only — the PR-branch execution gate no
    // longer consults it (the gate verifies committed authors and never refuses
    // on a dirty tree; see lib/security/pr-branch-execution.ts).
    if (trustedLocalChanges) {
      job.contextMeta = JSON.stringify({ trustedLocalChanges: true });
    }
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

async function readWorkingTreeStatus(projPath: string): Promise<string> {
  const r = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (r.exitCode !== 0) return '';
  return r.stdout;
}

/**
 * Pluggable release pipeline entry point.
 *
 * Flow: tests (if configured) → review → commit → push. Subsequent steps are driven by
 * the release orchestrator (`lib/workflows/release-orchestrator.ts`) — this helper only
 * starts the first step. Caller must ensure `auto_push_enabled` is set for the
 * chaining to continue automatically.
 *
 * Decision order:
 *  1. If no changes and no unpushed commits → nothing to release
 *  2. If a test command is configured/detected → start tests
 *  3. If there are changes or unpushed commits → start review, unless
 *     review is disabled or dirty paths are only committed TamTam metadata
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

async function notifySpendExceeded(block: SpendCapExceeded, jobId: string): Promise<void> {
  await notify({
    event: 'budget_exceeded',
    project: block.project,
    job_id: jobId,
    status: 'failed',
    reason: `${block.kind}_spend_cap`,
    cost_usd: block.actualUsd,
    message: `${block.detail}. Cap ${block.capUsd.toFixed(4)}, actual ${block.actualUsd.toFixed(4)}.`,
    throttleKeySuffix: `${block.kind}:${block.releaseId ?? 'project'}`,
    timestamp: Date.now(),
  });
}

async function createBlockedReleaseJob(projectName: string, reason: string): Promise<string | null> {
  try {
    const { logDir } = getImproveConfig();
    mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });
    const job = createJob(projectName, 'release', process.pid, '', undefined, undefined, undefined, undefined, undefined, undefined, null);
    job.releaseId = job.id;
    const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
    job.logPath = logPath;
    job.contextMeta = JSON.stringify({ releaseStopReason: reason });
    appendRedactedFileSync(logPath, `# release blocked — ${new Date().toISOString()}\n# project: ${projectName}\n# reason: ${reason}\n`);
    updateJob(job);
    const { finalizeAbortedRelease } = await import('@/lib/jobs/lifecycle');
    await finalizeAbortedRelease(job);
    return job.id;
  } catch (err) {
    console.warn(`[release] failed to create blocked release row for ${projectName}:`, err);
    return null;
  }
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
  const dailySpendCap = await checkDailySpendCap(projectName);
  if (!dailySpendCap.ok) {
    const jobId = await createBlockedReleaseJob(projectName, dailySpendCap.detail);
    await notifySpendExceeded(dailySpendCap, jobId ?? `${projectName}-release-budget-exceeded`);
    return { ok: false, status: 429, detail: dailySpendCap.detail };
  }
  const sourceJob = options.sourceJobId ? getJob(options.sourceJobId) : null;
  const parentJobId = sourceJob?.project === projectName ? sourceJob.id : null;
  // Provenance marker recorded on the release row (see createReleaseJob): a
  // release whose working-tree delta was produced by TamTam's own in-process
  // agent run (issue-cruncher, or a manual issue-linked `run`) or an
  // operator-initiated release. Retained for trace/audit only — the PR-branch
  // execution gate no longer reads it (it verifies committed authors and never
  // refuses on a dirty tree).
  const trustedLocalChanges =
    options.operatorInitiated === true ||
    (!!sourceJob && sourceJob.project === projectName && (
      isAgentJobKind(sourceJob.kind) ||
      (sourceJob.kind === 'run' && sourceJob.ghIssueNumber != null)
    ));
  // ── CI-red gate ──────────────────────────────────────────────────────────
  // Don't pile a new automatic feature release onto a red default-branch CI.
  // The vicious cycle this breaks: feature PRs keep merging (their PR check is
  // green) while the post-merge default-branch CI stays failing and nothing
  // repairs it, so every cycle adds another merge on top of broken CI. When the
  // default-branch CI is red, refuse the feature release; the CI stays frozen
  // until it recovers. Refusing here also un-suppresses the `ci_red` inbox HITL
  // (it hides while a pipeline is active) and lets the bounded auto fix-ci
  // self-heal run (the project sweep's `decideAutoFixCi`, gated by
  // `auto_fix_ci_on_red_default_branch`, dispatches a per-failing-run-bounded
  // fix-ci and falls back to the ci_red HITL — merge-or-HITL preserved). The
  // fix-ci-chained release (sourceJob.kind === 'fix-ci') CARRIES the fix — never
  // block it, or CI could never go green — and operator-initiated releases are
  // the human override; both are exempt below.
  const blockOnRedCi = getSettings().block_release_on_red_ci;
  const defaultBranchCi = blockOnRedCi
    ? (await readCachedGhStatus(projectName).catch(() => null))?.ci ?? null
    : null;
  if (
    shouldBlockReleaseOnRedCi({
      blockEnabled: blockOnRedCi,
      operatorInitiated: options.operatorInitiated === true,
      sourceJobKind: sourceJob?.kind ?? null,
      ci: defaultBranchCi,
    })
  ) {
    return {
      ok: false,
      status: 409,
      detail: `Release blocked: default-branch CI is failing for ${projectName}. Not merging more work onto red CI until it recovers (auto fix-ci self-heals it, or an operator is prompted in the inbox).`,
    };
  }

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

  // Check "Nothing to release" BEFORE the blocking-job / pipeline-running
  // gates. Otherwise a release-after-run trigger on a project with no
  // commitable changes still hits `queueRelease(...)` when another agent is
  // running, which sets the pending-release flag. Subsequent drains keep
  // bouncing off the same "agent already running" blocker, the flag never
  // clears, and every new agent on the project gets stalled behind a
  // pending release that never resolves. Doing the cheap git check first
  // means empty trees return a clean 400 with no side effects.
  const status = await readWorkingTreeStatus(projPath);
  const changes = statusHasAnyPath(status);
  const unpushed = await hasLocalCommitsAhead(projPath);
  const hasOnlyCommittedTamtamMetadataChanges = changes && statusHasOnlyCommittedTamtamMetadataPaths(status) && !unpushed;
  if (!changes && !unpushed) {
    return { ok: false, status: 400, detail: 'Nothing to release — no changes and no unpushed commits' };
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

  // Serialize across the pr-wait window: don't start a new release (which would
  // open a second PR or push to master) while a PR is already awaiting merge.
  // Concurrent PRs race the same base and the loser conflicts; holding here
  // keeps master frozen from issue-work start until merge. The queued release
  // drains when the pr-wait clears (PR merged → lock/completion event fires the
  // pending-release sweep).
  const activePrWait = findActivePrWait(listJobs(), projectName);
  if (activePrWait) {
    if (options.queueIfBlocked) return queueRelease(projectName, activePrWait.id);
    return {
      ok: false,
      status: 409,
      detail: `Release deferred: a PR is awaiting merge for ${projectName} (pr-wait ${activePrWait.id}); holding master to avoid concurrent-PR conflicts`,
      blockingJobId: activePrWait.id,
    };
  }

  const issueContext = await resolveReleaseIssueContext(projectName, projPath, sourceJob);

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

  const release = await createReleaseJob(projectName, projPath, parentJobId, issueContext, trustedLocalChanges);
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
  // One DB read for both `testsDisabled` and `reviewDisabled` instead of
  // three separate `getProjectTestConfig` round-trips below.
  const releaseConfig = await getProjectTestConfig(projectName);
  const testsDisabled = !!releaseConfig?.testsDisabled;
  const reviewDisabled = !!releaseConfig?.reviewDisabled;

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
      // skipToPush already captured hasFreshLgtm above — same project state,
      // same answer; one fewer DB round-trip per release.
      if (skipToPush) {
        const r = await startProjectPush(projectName);
        if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
        return { ok: true, step: 'push' as const, releaseJobId, message: r.message };
      }
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
    // agent's own prompt as the review step. Committed TamTam metadata also
    // skips review because start-review excludes those paths from scope.
    // Local scratch under `.tamtam/cache/**` is not committed metadata.
    // No autoCommit gating needed: we're already inside an explicit release,
    // which implies commit intent (same reason job-storage.ts's completion hook
    // lets `inRelease` bypass autoCommitEnabled). reviewDisabled was read once
    // above from the shared releaseConfig snapshot.
    if (reviewDisabled || hasOnlyCommittedTamtamMetadataChanges) {
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
      // Not every 409 is the same. A *concurrency* 409 is transient — another
      // driver already started this phase for the release (e.g. a boot-recovery
      // resume that won the atomic start claim). There we must NOT finalize: the
      // in-flight step + orchestrator drive the chain, and the lock is held by
      // that holder. But a *permanent-refusal* 409 (e.g. the PR-branch execution
      // gate rejecting an untrusted dirty tree) leaves nothing running — no child
      // phase, no held start-slot — so bowing out would strand the release in
      // `running` with the lock held until the childless-release reaper finally
      // frees it 120s later. Distinguish them by whether any driver is actually
      // active for this release; only then bow out silently (healthy release, no
      // failure state written). Otherwise fall through and finalize now so the
      // lock frees immediately.
      if (result.status === 409) {
        const { hasHeldStartSlotForRelease } = await import('./pipeline-start-slot');
        const anotherDriverActive =
          hasHeldStartSlotForRelease(releaseJobId) ||
          listJobs().some((j) => j.releaseId === releaseJobId && PIPELINE_STEP_KINDS.has(j.kind) && j.finishedAt === null);
        if (anotherDriverActive) {
          return result;
        }
      }
      // Persist + log the failure reason. Previously the release row was
      // finalized exit 1 with NO recorded detail, so a blocked release showed
      // an empty log and the operator couldn't tell why it didn't continue.
      if (releaseJob) {
        try {
          const meta = releaseJob.contextMeta ? JSON.parse(releaseJob.contextMeta) : {};
          const merged = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : {};
          merged.releaseStopReason = `release first-step failed: ${result.detail}`;
          releaseJob.contextMeta = JSON.stringify(merged);
          updateJob(releaseJob);
        } catch { /* best-effort */ }
        if (releaseJob.logPath) {
          try { appendRedactedFileSync(releaseJob.logPath, `\n# release first-step failed: ${result.detail}\n`); } catch {}
        }
      }
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
