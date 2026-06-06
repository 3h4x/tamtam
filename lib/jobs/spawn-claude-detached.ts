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
import { constants as osConstants, homedir, tmpdir } from 'os';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { splitCommand } from '@/lib/shared/split-command';
import { wrapForSandbox } from '@/lib/shared/sandbox-wrap';
import { measurePrompt, checkPromptSize } from './prompt-size';
import { redactSecrets } from '@/lib/shared/log-redaction';
import { buildChildEnv } from '@/lib/shared/child-env';
import type { JobData } from '@/lib/jobs/types';

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
  options?: { env?: Record<string, string>; cleanup?: () => void },
): Promise<number> {
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      options?.cleanup?.();
    } catch (err) {
      console.warn(`[spawn-claude-detached] cleanup failed for ${jobId}:`, err);
    }
  };

  let promptPath = '';
  let logPath = '';
  let logFd: number | null = null;
  let logLine: ((s: string) => void) | null = null;
  let jobsCache: Map<string, JobData> | null = null;
  let markDone: ((job: JobData, exitCode: number) => Promise<void>) | null = null;
  let child;
  try {
    const LOG_DIR = resolveLogDir();
    mkdirSync(/*turbopackIgnore: true*/ LOG_DIR, { recursive: true });

    promptPath = join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.prompt`);

    writeFileSync(/*turbopackIgnore: true*/ promptPath, prompt);

    const promptBytes = measurePrompt(prompt);
    const jobStorage = await import('@/lib/jobs/job-storage');
    jobsCache = jobStorage.jobsCache;
    markDone = jobStorage.markDone;
    const job = jobsCache.get(jobId);
    logPath = job?.logPath || join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.log`);
    if (job) {
      job.logPath = logPath;
      job.promptBytes = promptBytes;
      checkPromptSize(jobId, job.kind, promptBytes);
      jobStorage.saveToDb(job);
    }

    const cmdArgv = splitCommand(command);
    if (cmdArgv.length === 0) {
      throw new Error(`startJobInProcess: empty command string for job ${jobId}`);
    }
    const [rawBin, ...rawArgs] = cmdArgv;
    const runDir = join(/*turbopackIgnore: true*/ tmpdir(), 'tamtam-runs', jobId);
    const wrap = wrapForSandbox({ bin: rawBin, args: rawArgs, cwd, runDir });
    const bin = wrap.bin;
    const args = wrap.args;

    const childEnv = buildChildEnv({ ...(options?.env ?? {}), ...wrap.env });

    logFd = openSync(/*turbopackIgnore: true*/ logPath, 'a');
    logLine = (s: string) => {
      try {
        writeSync(logFd!, redactSecrets(Buffer.isBuffer(s) ? s.toString('utf8') : String(s)));
      } catch { /* noop */ }
    };

    const launchedSummary = [bin, ...args]
      .map(a => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      .join(' ');
    logLine(`[tamtam] launching: ${launchedSummary}`);

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
    if (logLine) {
      logLine(`[tamtam] spawn failed: ${(err as Error).message}`);
    }
    try { if (logFd !== null) closeSync(logFd); } catch { /* noop */ }
    logFd = null;
    cleanup();
    throw err;
  }

  const pid = child.pid ?? 0;

  child.on('error', (err) => {
    logLine?.(`[tamtam] spawn error: ${err.message}`);
    try { if (logFd !== null) closeSync(logFd); } catch { /* noop */ }
    logFd = null;
    cleanup();
  });

  // Pipe prompt file → stdin.
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
    logLine?.(`[tamtam] exited with code ${rc}${signal ? ` (signal ${signal})` : ''}`);
    try { if (logFd !== null) closeSync(logFd); } catch { /* noop */ }
    logFd = null;
    cleanup();
    // markDone parses the log for tokens/cost, applies Claude is_error overrides,
    // persists, and fires the pipeline completion-hook chain that drives the next
    // step (review → fix loop, fix → re-review or re-push).
    const liveJob = jobsCache?.get(jobId);
    if (liveJob && markDone) {
      markDone(liveJob, rc).catch((e) => {
        console.error(`[spawn-claude-detached] markDone failed for ${jobId}:`, e);
      });
    }
  });

  // Let the child outlive a brief parent stall (matches start-test.ts).
  child.unref();

  return pid;
}
