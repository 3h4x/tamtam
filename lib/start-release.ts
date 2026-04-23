import { appendFileSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveProjectPath } from './project-data';
import { startProjectTest, detectTestCommand } from './start-test';
import { startProjectReview } from './start-review';
import { startProjectPush } from './start-push';
import { startProjectCommit } from './start-commit';
import { listJobs, probeJobStatus, createJob, updateJob, getVerdict, markDone } from './job-storage';
import { isReviewed } from './git-utils';
import { exec } from './shell';
import { getImproveConfig, getProjectTestConfig } from './scheduling';
import { acquireLock, getLock } from './pipeline-lock';

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
  | { ok: false; status: number; detail: string; blockingJobId?: string };

// Create a meta "release" job and start a PM2 monitor process for it.
// The monitor polls the release log for the "# release finished" marker
// written by finalizeReleaseJob() and exits with the embedded exit code,
// giving the release job a real pid and PM2-managed lifecycle.
async function createReleaseJob(projectName: string): Promise<{ id: string; logPath: string } | null> {
  try {
    const { logDir } = getImproveConfig();
    mkdirSync(logDir, { recursive: true });

    const job = createJob(projectName, 'release', 0, '');
    const logPath = join(logDir, `${job.id}.log`);
    const scriptPath = join(logDir, `${job.id}.sh`);
    const monitorLogPath = join(logDir, `${job.id}.monitor.log`);
    job.logPath = logPath;

    appendFileSync(logPath, `# release start — ${new Date().toISOString()}\n# project: ${projectName}\n`);

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
    return { id: job.id, logPath };
  } catch {
    return null;
  }
}

async function hasChanges(projPath: string): Promise<boolean> {
  const r = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (r.exitCode !== 0) return false;
  return r.stdout.split('\n').some((l) => l.trim());
}

async function hasUnpushedCommits(projPath: string): Promise<boolean> {
  const r = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
  if (!r.stdout.trim() || r.exitCode !== 0) return false;
  const n = parseInt(r.stdout.trim(), 10);
  return !isNaN(n) && n > 0;
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
 *  3. If there are changes → start review
 *  4. If only unpushed commits → push directly
 */
export async function startRelease(projectName: string): Promise<ReleaseResult> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };

  if (await isReleasePipelineRunning(projectName)) {
    return { ok: false, status: 409, detail: `Release pipeline already running for ${projectName}` };
  }

  const changes = await hasChanges(projPath);
  const unpushed = await hasUnpushedCommits(projPath);
  if (!changes && !unpushed) {
    return { ok: false, status: 400, detail: 'Nothing to release — no changes and no unpushed commits' };
  }

  // Pre-check the lock before creating the release job — otherwise a 409 return
  // leaves an orphan "release" row with finishedAt=null showing as running forever.
  // Self-heal: if the holder is already terminal (zombie lock from a completion
  // hook that skipped releaseLock), ignore it — acquireLock below will clean up.
  const existingLock = getLock(projectName);
  if (existingLock) {
    const holder = listJobs().find(j => j.id === existingLock.lockedByJobId);
    const holderFinished = holder ? holder.finishedAt !== null : false;
    if (holder && !holderFinished) {
      return { ok: false, status: 409, detail: `Pipeline already running for ${projectName}`, blockingJobId: existingLock.lockedByJobId };
    }
  }

  const release = await createReleaseJob(projectName);
  if (!release) {
    return { ok: false, status: 500, detail: 'Failed to create release job' };
  }
  const releaseJobId = release.id;

  // Acquire lock. If a concurrent caller won the race after our pre-check,
  // mark our just-created release job done so it doesn't linger as running.
  const lockResult = await acquireLock(projectName, releaseJobId);
  if (!lockResult.acquired) {
    try {
      const jobRow = listJobs().find(j => j.id === releaseJobId);
      if (jobRow) await markDone(jobRow, 1);
    } catch {}
    return { ok: false, status: 409, detail: `Pipeline already running for ${projectName}`, blockingJobId: lockResult.blockingJobId };
  }

  // Fast-path: the working tree already has a valid LGTM review (hash
  // unchanged since markReviewed). Re-running tests and review would be
  // busywork — skip straight to commit & push. This keeps Release as a
  // single button while still being smart about what to do.
  const skipToPush = await hasFreshLgtm(projectName, projPath);

  // No uncommitted changes, just push existing commits.
  if (!changes) {
    const r = await startProjectPush(projectName);
    if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
    return { ok: true, step: 'push', releaseJobId, message: r.message };
  }

  // Fresh LGTM and there are uncommitted changes — commit them first, then push.
  if (skipToPush) {
    const r = await startProjectCommit(projectName);
    if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
    return { ok: true, step: 'push', releaseJobId, message: r.message };
  }

  // Has uncommitted changes — run tests first (if configured), then review.
  const testCmd = detectTestCommand(projPath, projectName);
  if (testCmd) {
    const r = await startProjectTest(projectName);
    if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
    return { ok: true, step: 'test', jobId: r.jobId, releaseJobId, message: `Running tests (${r.testCmd})` };
  }

  // If review is disabled per-project, short-circuit to commit — treat the
  // agent's own prompt as the review step. No autoCommit gating needed: we're
  // already inside an explicit release, which implies commit intent (same reason
  // job-storage.ts's completion hook lets `inRelease` bypass autoCommitEnabled).
  const reviewDisabled = !!getProjectTestConfig(projectName)?.reviewDisabled;
  if (reviewDisabled) {
    const r = await startProjectCommit(projectName);
    if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
    return { ok: true, step: 'commit', releaseJobId, message: r.message };
  }

  const r = await startProjectReview(projectName);
  if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
  return { ok: true, step: 'review', jobId: r.jobId, releaseJobId, message: 'Running review' };
}

// Returns true when the project's most recent finished review is LGTM AND
// the working-tree hash still matches the one markReviewed captured. That's
// the signal that re-running tests + review would add nothing.
async function hasFreshLgtm(projectName: string, projPath: string): Promise<boolean> {
  try {
    const latestReview = listJobs()
      .filter(j => j.project === projectName && j.kind === 'review' && j.finishedAt !== null && j.exitCode === 0)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    if (!latestReview) return false;
    if (getVerdict(latestReview) !== 'LGTM') return false;
    return await isReviewed(projectName, projPath);
  } catch {
    return false;
  }
}
