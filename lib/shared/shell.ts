import { execFile, spawn, ExecFileOptions } from 'child_process';
import { buildChildEnv } from '@/lib/shared/child-env';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function exec(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
    scrubSecrets?: boolean;
    killProcessGroup?: boolean;
    signal?: AbortSignal;
    abortProcessTree?: boolean;
  }
): Promise<ShellResult> {
  const mergedEnv = buildChildEnv(options?.env, { scrubSecrets: options?.scrubSecrets });

  // killProcessGroup=true: spawn detached so we can kill(-pid) the entire tree
  // (git → hook → check.ts → vitest workers) on timeout or parent exit.
  // abortProcessTree does the same for AbortSignal-driven commands whose
  // direct child can spawn hooks/subprocesses that must not outlive the abort.
  // Abort-aware commands also use spawn so an in-flight step can be cancelled.
  if (options?.killProcessGroup || options?.signal || options?.abortProcessTree) {
    return new Promise((resolve) => {
      // Buffer the chunks instead of doing `stdout += d.toString()` per chunk —
      // for high-volume children (pnpm test, pnpm dev) the per-chunk string
      // concatenation is O(n²) in V8 worst cases. Buffer.concat once at settle
      // time runs in one shot.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      const timeoutMs = options?.timeout ?? 15000;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;

      let child: ReturnType<typeof spawn> | null = null;
      let aborted = false;
      let exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let stdoutEnded = true;
      let stderrEnded = true;

      const killTree = !!options?.killProcessGroup || !!options?.abortProcessTree;

      const killGroup = (sig: NodeJS.Signals) => {
        if (child?.pid) {
          try {
            if (killTree) {
              process.kill(-child.pid, sig);
            } else {
              process.kill(child.pid, sig);
            }
          } catch {}
        }
      };

      const settle = (exitCode: number) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        if (options?.signal && abortListener) {
          options.signal.removeEventListener('abort', abortListener);
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode,
        });
      };

      const abortChild = () => {
        if (aborted) return;
        aborted = true;
        killGroup('SIGTERM');
        killEscalationTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
      };

      const abortListener = options?.signal
        ? () => {
            abortChild();
          }
        : null;

      try {
        child = spawn(cmd, args, {
          cwd: options?.cwd,
          env: mergedEnv,
          detached: killTree,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        stdoutEnded = !child.stdout;
        stderrEnded = !child.stderr;
      } catch (error) {
        stderrChunks.push(Buffer.from(error instanceof Error ? error.message : String(error)));
        settle(1);
        return;
      }

      killTimer = setTimeout(() => {
        abortChild();
        settle(1);
      }, timeoutMs);

      if (options?.signal) {
        if (options.signal.aborted) {
          abortChild();
        } else if (abortListener) {
          options.signal.addEventListener('abort', abortListener, { once: true });
        }
      }

      const settleFromChildResult = (code: number | null, signal: NodeJS.Signals | null) => {
        if (aborted || signal) {
          settle(130);
          return;
        }
        settle(code ?? 1);
      };
      const maybeSettleAfterStdio = () => {
        if (!exitResult || !stdoutEnded || !stderrEnded) return;
        settleFromChildResult(exitResult.code, exitResult.signal);
      };
      child.stdout?.on('data', (d: Buffer) => { stdoutChunks.push(d); });
      child.stdout?.on('end', () => {
        stdoutEnded = true;
        maybeSettleAfterStdio();
      });
      child.stderr?.on('data', (d: Buffer) => { stderrChunks.push(d); });
      child.stderr?.on('end', () => {
        stderrEnded = true;
        maybeSettleAfterStdio();
      });
      child.on('exit', (code, signal) => {
        exitResult = { code, signal };
        maybeSettleAfterStdio();
      });
      child.on('close', (code, signal) => {
        settleFromChildResult(code, signal);
      });
      child.on('error', (error) => {
        if (stderrChunks.length === 0) {
          stderrChunks.push(Buffer.from(error instanceof Error ? error.message : String(error)));
        }
        settle(1);
      });

      // Keep the child referenced until it closes. This helper returns the
      // command result, so unref() would let short-lived detached children exit
      // before Node flushes the stdio pipes and close event reliably.
    });
  }

  return new Promise((resolve) => {
    const opts: ExecFileOptions = {
      cwd: options?.cwd,
      timeout: options?.timeout ?? 15000,
      env: mergedEnv,
      maxBuffer: 10 * 1024 * 1024,
    };

    try {
      execFile(cmd, args, opts, (error, stdout, stderr) => {
        resolve({
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? '').toString(),
          exitCode: error ? (Number((error as NodeJS.ErrnoException).code) || 1) : 0,
        });
      });
    } catch (error) {
      resolve({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      });
    }
  });
}
