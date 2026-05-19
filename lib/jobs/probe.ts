import { existsSync, readFileSync, statSync } from 'fs';
import type { JobData } from './types';
import { isClaudeBackedJobKind } from './kinds';
import { getJobCancellationSignal } from './cancellation';
import { hasCloseHandlerPending } from './spawned-close-pending';

/** Read the sentinel exit-code file that `startProjectTest`'s spawned bash
 *  writes immediately before exiting. Returns null when the file is missing
 *  or unparseable so the caller can fall back to -1. */
function readTestExitCodeSentinel(logPath: string | null | undefined): number | null {
  if (!logPath) return null;
  const sentinel = `${logPath}.exitcode`;
  if (!existsSync(sentinel)) return null;
  try {
    const raw = readFileSync(sentinel, 'utf-8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Returns true when the log file has been modified within `windowMs`. Used
 *  as a fallback liveness check for test/action jobs whose pid wasn't
 *  persisted to the DB — if the log is still being written, the spawned
 *  process is still active even though we can't see its pid. */
function logRecentlyWritten(logPath: string | null | undefined, windowMs: number): boolean {
  if (!logPath || !existsSync(logPath)) return false;
  try {
    const stat = statSync(logPath);
    return Date.now() - stat.mtimeMs < windowMs;
  } catch {
    return false;
  }
}

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

  if (job.finishedAt !== null) return 'done';
  // Push and commit run inline in the Next.js server process. Their pid is
  // set to process.pid (the server's own PID) so we can detect restarts.
  // Same pid → still in-flight on this server instance; trust self-finalization.
  // Different pid → the server was restarted and killed the in-flight operation.
  if (job.kind === 'push' || job.kind === 'commit') {
    if (job.pid === process.pid) return 'running';
    await markDone(job, -1);
    return 'done';
  }
  // Release meta-jobs are coordinators, not subprocesses. With workflow-driven
  // orchestration the workflow runtime owns finalization — probing the meta-
  // job's pid is meaningless. Trust the workflow / completion-hook chain to
  // call finalizeReleaseJob; probe stays out of the way.
  if (job.kind === 'release') return 'running';
  // Jobs are created with pid=0 and the real pid is persisted asynchronously
  // after spawn returns. During that window, treat the job as still spawning
  // rather than dead — otherwise a concurrent probe (e.g. the duplicate-check
  // in /api/agents/[id]/run) would markDone(-1) mid-spawn and tear down the
  // nascent Claude process, leaving a phantom `exit -1 @ 0s` row. Grace is
  // intentionally generous to cover slow spawns plus slack for the server's
  // main loop.
  const PID_SPAWN_GRACE_SEC = 30;
  if (job.pid <= 0) {
    const ageSec = Date.now() / 1000 - job.startedAt;
    // For test/action jobs the sentinel file is the authoritative completion
    // signal — they often run longer than the spawn grace, and a server
    // restart between spawn and `updateJob(pid)` can leave the row stuck at
    // pid=0 even though the test is still running. Check sentinel/log mtime
    // first so a test running for several minutes isn't falsely declared dead.
    if (job.kind === 'test' || job.kind === 'action') {
      const sentinelExitCode = readTestExitCodeSentinel(job.logPath);
      if (sentinelExitCode != null) {
        await markDone(job, sentinelExitCode);
        return 'done';
      }
      // No sentinel yet. If the log was written recently the bash is still
      // running; only declare dead when the log is stale (5 min window).
      if (logRecentlyWritten(job.logPath, 5 * 60 * 1000)) return 'running';
      // Also keep within the original spawn grace before failing — gives the
      // post-spawn updateJob() a chance to backfill pid in normal startup.
      if (ageSec < PID_SPAWN_GRACE_SEC) return 'running';
      await markDone(job, -1);
      return 'done';
    }
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
    // For remaining kinds with pid=0 past the spawn grace: an un-aborted
    // cancellation signal means a route handler is still managing the job
    // inline (e.g. agent runs hold the signal while their prerequisite
    // command — `pnpm check` etc. — runs). Killing the row here would mutate
    // the route's cached JobData and trip its post-prereq cancel check.
    const inlineSignal = getJobCancellationSignal(job.id);
    if (inlineSignal && !inlineSignal.aborted) return 'running';
    await markDone(job, -1);
    return 'done';
  }
  // Claude CLI sometimes hangs after emitting its final result event (stop_reason
  // = end_turn, is_error = false, but the process never exits — most often seen on
  // long agent runs). If the log already contains a terminal result line, treat
  // the job as done. Applies to every claude-backed kind.
  const claudeKind = isClaudeBackedJobKind(job.kind);
  const resultExitCode = getClaudeResultExitCode(job);
  if (claudeKind && resultExitCode !== null) {
    await markDone(job, resultExitCode);
    return 'done';
  }
  // Test/action jobs check liveness via pid only.
  if (job.kind === 'test' || job.kind === 'action') {
    // The spawned child's `proc.on('close', …)` handler runs in this process
    // and races against this probe. If we declare the job dead here while the
    // close event is still queued in the event loop, our markDone(-1) wins
    // and the real exit code from the child is overwritten. Skip the ESRCH
    // path when the close handler is still pending so the close event lands
    // first.
    if (hasCloseHandlerPending(job.id)) return 'running';
    try {
      process.kill(job.pid, 0);
      return 'running';
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
      // Process is dead. The spawned bash writes its real exit code to a
      // `.exitcode` sentinel file before exiting. If that file is present,
      // use it — otherwise the close handler was lost (e.g. Next.js restart
      // mid-test) and we'd mis-record exit=-1 despite passing tests.
      const sentinelExitCode = readTestExitCodeSentinel(job.logPath);
      await markDone(job, sentinelExitCode ?? -1);
      return 'done';
    }
  }
  // Generic pid>0 liveness check via process.kill.
  try {
    process.kill(job.pid, 0);
    return 'running';
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
    await markDone(job, -1);
    return 'done';
  }
}
