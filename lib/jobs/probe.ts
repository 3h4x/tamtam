import { existsSync, readFileSync } from 'fs';
import { getJobStatus } from './pm2-jobs';
import { saveToDb } from './storage';
import type { JobData } from './types';
import { isClaudeBackedJobKind } from './kinds';
import { getJobCancellationSignal } from './cancellation';

// Returns the exit code implied by the Claude result line in the job's log:
//   0  if is_error: false (or the line can't be parsed)
//   1  if is_error: true
//   null if no result line exists yet
function getClaudeResultExitCode(job: JobData): number | null {
  if (!job.logPath || !existsSync(job.logPath)) return null;
  try {
    const content = readFileSync(job.logPath, 'utf-8');
    const marker = '"type":"result"';
    const lastIdx = content.lastIndexOf(marker);
    if (lastIdx === -1) return null;
    const lineStart = content.lastIndexOf('\n', lastIdx) + 1;
    const lineEnd = content.indexOf('\n', lastIdx);
    const raw = content.slice(lineStart, lineEnd !== -1 ? lineEnd : undefined).trim();
    // Aggregate / release logs prepend an ISO timestamp: strip it before parsing.
    const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:\s/;
    const body = raw.replace(TS_PREFIX_RE, '');
    const parsed = JSON.parse(body);
    return parsed.is_error ? 1 : 0;
  } catch {
    // Result line exists but can't be parsed — treat as success.
    return 0;
  }
}

export async function probeJobStatus(job: JobData): Promise<'running' | 'done'> {
  // Import markDone lazily to avoid circular deps (lifecycle → probe → lifecycle)
  const { markDone } = await import('./lifecycle');

  if (job.finishedAt !== null) {
    // Belt-and-braces: /api/jobs polls probeJobStatus frequently; use those
    // ticks to reconcile any stranded release whose children are all done.
    // Cheap (one listJobs filter) and no-op when the release has already
    // been finalized by the normal path.
    const { reconcileStaleRelease } = await import('./lifecycle');
    await reconcileStaleRelease(job);
    return 'done';
  }
  // Push and commit run inline in the Next.js server process. Their pid is
  // set to process.pid (the server's own PID) so we can detect restarts.
  // Same pid → still in-flight on this server instance; trust self-finalization.
  // Different pid → the server was restarted and killed the in-flight operation.
  if (job.kind === 'push' || job.kind === 'commit') {
    if (job.pid === process.pid) return 'running';
    await markDone(job, -1);
    return 'done';
  }
  // Jobs are created with pid=0 and the real pid is persisted asynchronously
  // after `pm2 start` returns (can take up to pm2's 15 s timeout). During that
  // window, treat the job as still spawning rather than dead — otherwise a
  // concurrent probe (e.g. the duplicate-check in /api/agents/[id]/run) would
  // markDone(-1) mid-spawn AND pm2-delete the nascent Claude process, leaving
  // a phantom `exit -1 @ 0s` row. Grace is intentionally generous because
  // `pm2 start` worst-case is ~15 s plus slack for the server's main loop.
  const PID_SPAWN_GRACE_SEC = 30;
  if (job.pid <= 0) {
    const ageSec = Date.now() / 1000 - job.startedAt;
    if (ageSec < PID_SPAWN_GRACE_SEC) return 'running';
    // Inline kinds run inside the next-server itself (pid intentionally 0
    // so markDone's SIGKILL fallback doesn't kill our own process). They
    // self-finalize via markDone(job, code) when the inline routine
    // returns, so probing them here is meaningless — declaring them dead
    // would race the in-flight Claude call (~30-180 s) and lose work.
    // Trust their self-finalization; if finishedAt is null, they're alive.
    if (job.kind === 'mark-dod' || job.kind === 'pr-wait') {
      return 'running';
    }
    // Non-PM2 kinds (test/action) have no name to look up in pm2 — dead means dead.
    if (job.kind === 'test' || job.kind === 'action') {
      await markDone(job, -1);
      return 'done';
    }
    // PM2-managed kinds: a race between `pm2 start` returning and `pm2 jlist`
    // reflecting the new process can leave job.pid=0 even though pm2 knows
    // about the job by name. Ask pm2 directly before declaring it dead —
    // otherwise we incorrectly markDone(-1) long-running jobs (classic
    // symptom: release jobs ending with exit_code=-1 despite the pipeline
    // succeeding and writing `# release finished — exit 0`).
    const { status, exitCode } = await getJobStatus(job.id);
    if (status === 'running') {
      // Opportunistically backfill pid so subsequent probes skip this path.
      try {
        const realPid = await (await import('@/lib/jobs/pm2-jobs')).getJobPid(job.id);
        if (realPid && realPid > 0) {
          job.pid = realPid;
          saveToDb(job);
        }
      } catch {}
      return 'running';
    }
    if (status === 'done') {
      await markDone(job, exitCode ?? -1);
      return 'done';
    }
    // status === 'unknown' — pm2 has no record. Before declaring dead, check
    // whether a route handler is still managing this job inline (e.g. agent
    // runs hold a cancellation signal while their prerequisite command is
    // executing — `pnpm check` etc. routinely takes >30s, exceeding the
    // pid-spawn grace). An un-aborted signal means the route is mid-prereq
    // and will spawn into pm2 once it returns; killing it here would mutate
    // the route's cached job reference and trip its post-prereq cancel check.
    const inlineSignal = getJobCancellationSignal(job.id);
    if (inlineSignal && !inlineSignal.aborted) return 'running';
    await markDone(job, -1);
    return 'done';
  }
  // Claude CLI sometimes hangs after emitting its final result event (stop_reason
  // = end_turn, is_error = false, but the process never exits — most often seen on
  // long agent runs). If the log already contains a terminal result line, treat
  // the job as done regardless of PM2 status. Applies to every claude-backed kind.
  const claudeKind = isClaudeBackedJobKind(job.kind);
  const resultExitCode = getClaudeResultExitCode(job);
  if (claudeKind && resultExitCode !== null) {
    await markDone(job, resultExitCode);
    return 'done';
  }
  // Test/action jobs spawn directly (no PM2) — check liveness via pid only.
  if (job.kind === 'test' || job.kind === 'action') {
    try {
      process.kill(job.pid, 0);
      return 'running';
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
      await markDone(job, -1);
      return 'done';
    }
  }
  const { status, exitCode } = await getJobStatus(job.id);
  if (status === 'running') return 'running';
  if (status === 'done') {
    await markDone(job, exitCode ?? -1);
    return 'done';
  }
  try {
    process.kill(job.pid, 0);
    return 'running';
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
    await markDone(job, -1);
    return 'done';
  }
}
