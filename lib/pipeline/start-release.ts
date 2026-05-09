import { appendFileSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { startProjectTest, detectTestCommand } from './start-test';
import { startProjectReview } from './start-review';
import { startProjectPush } from './start-push';
import { startProjectCommit } from './start-commit';
import { listJobs, probeJobStatus, createJob, updateJob, getJob, runWithParent } from '@/lib/jobs/job-storage';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig, getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { acquireLock, releaseLock, reassignLock } from './pipeline-lock';
import { detectMainBranch, findIssueContext } from './start-commit';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { hasFreshLgtm, hasLocalCommitsAhead } from './release-state';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import type { IssueContext } from './release-context';

const RELEASE_PIPELINE_KINDS = new Set(['test', 'review', 'fix', 'push', 'fix-push', 'pr-wait', 'mark-dod', 'release']);

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

// Create a meta "release" job and start a PM2 monitor process for it.
// The monitor polls the release log for the "# release finished" marker
// written by finalizeReleaseJob() and exits with the embedded exit code,
// giving the release job a real pid and PM2-managed lifecycle.
async function createReleaseJob(
  projectName: string,
  parentJobId?: string | null,
  issueContext?: IssueContext | null,
): Promise<{ id: string; releaseId: string; logPath: string } | null> {
  try {
    const { logDir } = getImproveConfig();
    mkdirSync(logDir, { recursive: true });

    const job = createJob(projectName, 'release', 0, '', undefined, undefined, undefined, undefined, undefined, undefined, parentJobId);
    const logPath = join(logDir, `${job.id}.log`);
    const scriptPath = join(logDir, `${job.id}.sh`);
    const monitorLogPath = join(logDir, `${job.id}.monitor.log`);
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
    // for traceability. The release trace UI surfaces this via parentJobId,
    // so we deliberately do NOT mutate the trigger's releaseId — that would
    // re-group the parent run under this release in /runs views and other
    // dashboards that filter by releaseId.
    let triggerLine = '';
    if (job.parentJobId) {
      const trigger = getJob(job.parentJobId);
      if (trigger && trigger.project === projectName) {
        triggerLine = `# triggered by: ${trigger.kind} ${trigger.id}\n`;
      }
    }

    appendFileSync(logPath, `# release start — ${new Date().toISOString()}\n# project: ${projectName}\n${triggerLine}`);

    // Bash monitor: polls the release log for the completion marker, then exits
    // with the embedded exit code so PM2 records it correctly.
    const scriptContent = [
      '#!/bin/bash',
      `export PATH="${process.env.PATH || ''}"`,
      `export HOME="${homedir()}"`,
      `RELEASE_LOG="${logPath}"`,
      'TIMEOUT=14400',
      'elapsed=0',
      'echo "[tamtam] release monitor started"',
      'while [ "$elapsed" -lt "$TIMEOUT" ]; do',
      '  sleep 2',
      '  elapsed=$((elapsed + 2))',
      '  if [ -f "$RELEASE_LOG" ]; then',
      "    line=$(grep -m1 '^# release finished' \"$RELEASE_LOG\" 2>/dev/null || true)",
      '    if [ -n "$line" ]; then',
      "      code=$(echo \"$line\" | sed 's/.*exit \\([0-9]*\\).*/\\1/')",
      '      echo "[tamtam] release finished (exit $code)"',
      '      exit "$code"',
      '    fi',
      '  fi',
      'done',
      'echo "[tamtam] release monitor timed out"',
      'exit 1',
    ].join('\n');

    writeFileSync(scriptPath, scriptContent);
    chmodSync(scriptPath, 0o755);

    const pm2Result = await exec(
      'pm2',
      [
        'start', scriptPath,
        '--name', job.id,
        '--no-autorestart',
        '--output', monitorLogPath,
        '--error', monitorLogPath,
        '--merge-logs',
      ],
      { timeout: 15000 }
    );

    if (pm2Result.exitCode !== 0) {
      throw new Error(`pm2 start failed: ${pm2Result.stderr}`);
    }

    // Retry jlist a few times — right after `pm2 start` returns, jlist can
    // still show the new process with pid=0/undefined for up to ~1 s while
    // PM2 wires it up. Storing pid=0 would later confuse probeJobStatus into
    // thinking the release monitor died (→ exit_code=-1 for an otherwise
    // successful release).
    let pid = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const jlistR = await exec('pm2', ['jlist'], { timeout: 10000 });
      try {
        const procs: Array<{ name: string; pid?: number }> = JSON.parse(jlistR.stdout);
        const found = procs.find((p) => p.name === job.id)?.pid ?? 0;
        if (found > 0) { pid = found; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    job.pid = pid;
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
/**
 * Returns the current branch name if agent runs should be blocked (Direct Branch
 * mode + fix/issue-* branch checked out), otherwise null.
 */
export async function checkIssueBranchBlock(
  projectName: string,
  projPath: string,
): Promise<string | null> {
  const cfg = getProjectTestConfig(projectName);
  if (!cfg || cfg.prWorkflowEnabled) return null;
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const branch = branchR.stdout.trim();
  return branch.startsWith('fix/issue-') ? branch : null;
}

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
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };
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

  // In Direct Branch mode, guard against releasing from an unexpected branch.
  // fix/issue-* branches are "expected" (issue work), but any other non-default
  // branch indicates the user landed here by accident and the push would go to
  // the wrong place. Reject early with a clear message rather than silently
  // pushing to the wrong branch.
  const releaseCfg = getProjectTestConfig(projectName);
  if (releaseCfg && !releaseCfg.prWorkflowEnabled) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const currentBranch = branchR.stdout.trim();
    if (currentBranch && !currentBranch.startsWith('fix/issue-')) {
      const defaultBranch = await detectMainBranch(projPath);
      if (currentBranch !== defaultBranch) {
        return {
          ok: false,
          status: 409,
          detail: `Direct Branch mode: working copy is on '${currentBranch}' (expected '${defaultBranch}' or a fix/issue-* branch). Switch branches before releasing.`,
        };
      }
    }
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

  const hasIssueTaggedRun = listJobs().some(
    (job) => job.project === projectName && job.kind === 'run' && job.ghIssueNumber != null,
  );
  const issueContext = sourceJob?.project === projectName && sourceJob.ghIssueNumber != null
    ? {
        number: sourceJob.ghIssueNumber,
        repo: sourceJob.ghIssueRepo ?? '',
        title: sourceJob.ghIssueTitle ?? '',
      }
    : hasIssueTaggedRun
      ? await findIssueContext(projectName, projPath)
      : null;

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

  const release = await createReleaseJob(projectName, parentJobId, issueContext);
  if (!release) {
    releaseLock(projectName, placeholderId);
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

  const testCmd = detectTestCommand(projPath, projectName);
  const testsDisabled = !!getProjectTestConfig(projectName)?.testsDisabled;

  // First step's parent is the release meta job, not whatever triggered the
  // release (agent run, manual click). Switching the AsyncLocalStorage parent
  // here makes the chain read as: agent → release → test → review → commit → push.
  return runWithParent(releaseJobId, async () => {
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
      const reviewDisabled = !!getProjectTestConfig(projectName)?.reviewDisabled;
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
    const reviewDisabled = !!getProjectTestConfig(projectName)?.reviewDisabled;
    if (reviewDisabled) {
      const r = await startProjectCommit(projectName);
      if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
      return { ok: true, step: 'commit' as const, releaseJobId, message: r.message };
    }

    const r = await startProjectReview(projectName);
    if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
    return { ok: true, step: 'review' as const, jobId: r.jobId, releaseJobId, message: 'Running review' };
  });
}

// Returns true when the project's most recent finished review is LGTM AND
// the working-tree hash still matches the one markReviewed captured. That's
// the signal that re-running tests + review would add nothing.
