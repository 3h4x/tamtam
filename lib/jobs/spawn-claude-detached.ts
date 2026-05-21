// Fire-and-forget in-process spawn for Claude-CLI-backed jobs (review, fix,
// pr-review, terminal `run`). Same call shape as the old PM2 startJob(): write
// prompt file, spawn detached, return child PID immediately. Lifecycle
// continues via child.on('exit') which calls markDone(); the completion-hook
// chain takes it from there.
//
// Surviving a Next.js restart:
//   - `detached: true` + `child.unref()` puts the child in its own process
//     group so SIGTERM to the parent (PM2 restart) does NOT propagate.
//   - stdout/stderr are redirected to the log file's fd directly via
//     `stdio: ['pipe', logFd, logFd]`. If we piped them back to Node instead,
//     the pipe would break on parent death and the next child write would get
//     SIGPIPE — killing it despite the detached process group. Writing to the
//     fd means the kernel owns the connection; the child's own fd handle
//     survives the parent disappearing.
//   - When the parent does die mid-run, the child keeps writing to the log;
//     on next boot, probeJobStatus uses `process.kill(pid, 0)` for liveness
//     and getClaudeResultExitCode reads the trailing `"type":"result"` line
//     from the log to recover the exit code without ever needing this
//     in-process `child.on('exit')` handler.
//   - The prompt is fed via stdin pipe and stdin closes within a few ms; by
//     the time PM2 could possibly restart tamtam, stdin is long done, so the
//     remaining stdin pipe breakage is harmless.

import { spawn } from 'child_process';
import { openSync, closeSync, createReadStream, writeFileSync, mkdirSync, writeSync } from 'fs';
import { join } from 'path';
import { constants as osConstants, homedir } from 'os';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { splitCommand } from '@/lib/shared/split-command';
import { measurePrompt, checkPromptSize } from './prompt-size';
import { redactSecrets } from '@/lib/shared/log-redaction';
import { buildChildEnv } from '@/lib/shared/child-env';

// Canonical signal-name → signum table. Hoisted from the per-exit
// `require('os').constants.signals` lookup in the child.on('exit') handler.
const OS_SIGNAL_NUMS = osConstants.signals as Record<string, number>;

function resolveLogDir(): string {
  try {
    return getImproveConfig().logDir;
  } catch {
    return join(/*turbopackIgnore: true*/ homedir(), 'logs');
  }
}

export async function startJobInProcess(
  jobId: string,
  command: string,
  prompt: string,
  cwd: string,
  options?: { env?: Record<string, string> },
): Promise<number> {
  const LOG_DIR = resolveLogDir();
  mkdirSync(/*turbopackIgnore: true*/ LOG_DIR, { recursive: true });

  const promptPath = join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.prompt`);
  const logPath = join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.log`);

  writeFileSync(/*turbopackIgnore: true*/ promptPath, prompt);

  const promptBytes = measurePrompt(prompt);
  const { jobsCache, saveToDb, markDone } = await import('@/lib/jobs/job-storage');
  const job = jobsCache.get(jobId);
  if (job) {
    job.promptBytes = promptBytes;
    checkPromptSize(jobId, job.kind, promptBytes);
    saveToDb(job);
  }

  const cmdArgv = splitCommand(command);
  if (cmdArgv.length === 0) {
    throw new Error(`startJobInProcess: empty command string for job ${jobId}`);
  }
  const [bin, ...args] = cmdArgv;

  const childEnv = buildChildEnv(options?.env);

  const logFd = openSync(/*turbopackIgnore: true*/ logPath, 'a');
  const writeLog = (chunk: Buffer | string) => {
    try {
      writeSync(logFd, redactSecrets(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)));
    } catch { /* noop */ }
  };
  const logLine = (s: string) => writeLog(s.endsWith('\n') ? s : `${s}\n`);

  const launchedSummary = [bin, ...args]
    .map(a => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
  logLine(`[tamtam] launching: ${launchedSummary}`);

  let child;
  try {
    // Pass the log fd directly to the child for stdout/stderr. The kernel
    // dup's it into the child process; the child keeps writing to the file
    // even if our process disappears, so a PM2 restart no longer SIGPIPEs
    // the codex/claude CLI on its next stdout write.
    child = spawn(bin, args, {
      stdio: ['pipe', logFd, logFd],
      env: childEnv,
      cwd,
      detached: true,
    });
  } catch (err) {
    logLine(`[tamtam] spawn failed: ${(err as Error).message}`);
    try { closeSync(logFd); } catch { /* noop */ }
    throw err;
  }

  const pid = child.pid ?? 0;

  child.on('error', (err) => {
    logLine(`[tamtam] spawn error: ${err.message}`);
  });

  // Pipe prompt file → stdin (matches scripts/job-runner.js).
  try {
    const promptStream = createReadStream(/*turbopackIgnore: true*/ promptPath);
    promptStream.on('error', (err) => {
      logLine(`[tamtam] prompt read error: ${err.message}`);
      try { child.stdin?.end(); } catch { /* noop */ }
    });
    promptStream.pipe(child.stdin!).on('error', () => { /* child closed stdin early */ });
  } catch (err) {
    logLine(`[tamtam] prompt open error: ${(err as Error).message}`);
    try { child.stdin?.end(); } catch { /* noop */ }
  }

  child.on('exit', (code, signal) => {
    let rc: number;
    if (code != null) {
      rc = code;
    } else if (signal) {
      rc = 128 + (OS_SIGNAL_NUMS[signal] ?? 0);
    } else {
      rc = 1;
    }
    logLine(`[tamtam] exited with code ${rc}${signal ? ` (signal ${signal})` : ''}`);
    try { closeSync(logFd); } catch { /* noop */ }
    // markDone parses the log for tokens/cost, applies Claude is_error overrides,
    // persists, and fires the pipeline completion-hook chain that drives the next
    // step (review → fix loop, fix → re-review or re-push).
    const liveJob = jobsCache.get(jobId);
    if (liveJob) {
      markDone(liveJob, rc).catch((e) => {
        console.error(`[spawn-claude-detached] markDone failed for ${jobId}:`, e);
      });
    }
  });

  // Let the child outlive a brief parent stall (matches start-test.ts).
  child.unref();

  return pid;
}
