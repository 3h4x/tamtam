// In-process port of scripts/job-runner.js. Replaces the PM2 spawn path for
// jobs that live inside a Workflow step: the step body calls runSubprocess,
// awaits the child's exit, and then calls markDone() itself.
//
// Why in-process: PM2 was a workaround for "Next.js doesn't have a durable
// queue." Now the Workflow runtime owns durability — the step is the
// in-process equivalent of "PM2 supervising a one-shot," with the workflow
// run table replacing the PM2 jlist as the source of truth for liveness.

import { spawn } from 'child_process';
import { closeSync, createReadStream, openSync, writeSync } from 'fs';
import { redactSecrets } from '@/lib/shared/log-redaction';
import { buildChildEnv } from '@/lib/shared/child-env';

export interface RunSubprocessParams {
  jobId: string;
  cmd: string;
  cmdArgs: string[];
  promptPath: string;
  logPath: string;
  env?: Record<string, string>;
  cwd?: string;
  abortSignal?: AbortSignal;
  onSpawn?: (pid: number) => void;
}

export interface RunSubprocessResult {
  pid: number;
  exitCode: number;
  signal: NodeJS.Signals | null;
  outputTail?: string;
}

function quoteArg(a: string): string {
  return /\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

export async function runSubprocess(params: RunSubprocessParams): Promise<RunSubprocessResult> {
  const { jobId: _jobId, cmd, cmdArgs, promptPath, logPath, env, cwd, abortSignal, onSpawn } = params;

  const logFd = openSync(/*turbopackIgnore: true*/ logPath, 'a');
  let outputTail = '';
  const writeLog = (chunk: Buffer | string) => {
    try {
      const redacted = redactSecrets(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      outputTail = (outputTail + redacted).slice(-64 * 1024);
      writeSync(logFd, redacted);
    } catch { /* noop */ }
  };
  const logLine = (s: string) => writeLog(s.endsWith('\n') ? s : `${s}\n`);

  const launchedSummary = [cmd, ...cmdArgs].map(quoteArg).join(' ');
  logLine(`[tamtam] launching: ${launchedSummary}`);

  const childEnv = buildChildEnv(env);

  return new Promise<RunSubprocessResult>((resolve) => {
    let settled = false;
    const finish = (result: RunSubprocessResult) => {
      if (settled) return;
      settled = true;
      try { closeSync(logFd); } catch { /* noop */ }
      resolve(result);
    };

    let child;
    try {
      child = spawn(cmd, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        cwd,
      });
    } catch (err) {
      logLine(`[tamtam] spawn failed: ${(err as Error).message}`);
      finish({ pid: 0, exitCode: 127, signal: null, outputTail });
      return;
    }

    const pid = child.pid ?? 0;
    if (pid > 0) onSpawn?.(pid);

    child.stdout?.on('data', writeLog);
    child.stderr?.on('data', writeLog);
    child.on('error', (err) => {
      logLine(`[tamtam] spawn error: ${err.message}`);
    });

    // Pipe prompt file into child's stdin (the legacy bash wrapper used
    // `cat "$PROMPT" | <cmd>`).
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

    // Cancellation: forward an external AbortSignal as SIGTERM. The child's
    // own SIGTERM handler does the graceful shutdown; we don't follow up
    // with SIGKILL here because the existing kill-tree path in
    // lib/jobs/lifecycle.ts (markDone → killTree with SAFE_PID_FLOOR guard)
    // is the safety net.
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('exit', (code, signal) => {
      // Mirror job-runner.js's rc computation: signal → 128 + signum.
      let rc: number;
      if (code != null) {
        rc = code;
      } else if (signal) {
        // os.constants.signals is the canonical signum table.
        const sigs = require('os').constants.signals as Record<string, number>;
        rc = 128 + (sigs[signal] ?? 0);
      } else {
        rc = 1;
      }
      logLine(`[tamtam] exited with code ${rc}${signal ? ` (signal ${signal})` : ''}`);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      finish({ pid, exitCode: rc, signal, outputTail });
    });
  });
}
