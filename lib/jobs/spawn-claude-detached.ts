// Fire-and-forget in-process spawn for Claude-CLI-backed pipeline jobs
// (review, fix, fix-push, pr-review). Same call shape as
// lib/jobs/pm2-jobs.ts startJob() — writes prompt file, spawns detached,
// returns child PID immediately. Lifecycle continues via child.on('close')
// which calls markDone(); the pipeline completion-hook chain takes it from
// there exactly as it did under PM2.
//
// Differences from inline-agent.ts startInProcessAgentJob:
//   - Does NOT await the child's exit. The caller (completion-hook handler)
//     fires the next pipeline step; we mustn't block that.
//   - The child is detached + unref'd so a Next.js restart doesn't kill it
//     (matches start-test.ts's existing pattern; the trade-off is the child
//     becomes a true orphan on restart and lifecycle hooks for it are lost).

import { spawn } from 'child_process';
import { openSync, closeSync, createReadStream, writeFileSync, mkdirSync, writeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { splitCommand } from './pm2-jobs';
import { measurePrompt, checkPromptSize } from './prompt-size';
import { redactSecrets } from '@/lib/shared/log-redaction';

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

  // Avoid the spawned process binding to Next.js's port.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(options?.env ?? {}) };
  delete childEnv.PORT;
  delete childEnv.HOSTNAME;

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
    child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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

  child.stdout?.on('data', writeLog);
  child.stderr?.on('data', writeLog);
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
      const sigs = require('os').constants.signals as Record<string, number>;
      rc = 128 + (sigs[signal] ?? 0);
    } else {
      rc = 1;
    }
    logLine(`[tamtam] exited with code ${rc}${signal ? ` (signal ${signal})` : ''}`);
    try { closeSync(logFd); } catch { /* noop */ }
    // markDone parses the log for tokens/cost, applies Claude is_error overrides,
    // persists, and fires the pipeline completion-hook chain that drives the next
    // step (review → fix loop, fix → re-review, fix-push → push retry).
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
