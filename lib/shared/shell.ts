import { execFile, spawn, ExecFileOptions } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const extraPaths = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'Library', 'pnpm'),
  join(homedir(), '.nvm', 'versions', 'node'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function enrichPath(): string {
  const current = process.env.PATH || '';
  const additions = extraPaths.filter((p) => !current.includes(p));
  return [...additions, current].join(':');
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Strip pnpm/npm env vars that pollute child processes
    if (key.startsWith('npm_') || key.startsWith('PNPM_') || key === 'NODE_PATH') continue;
    // Strip PORT/HOSTNAME — Next sets these in its own process from --port/--hostname
    // flags, so without this, every child process tamtam spawns inherits PORT=1337
    // and any Next dev server we launch from a custom action would try to bind
    // there instead of its own default.
    if (key === 'PORT' || key === 'HOSTNAME') continue;
    env[key] = value;
  }
  return env;
}

export function exec(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
    killProcessGroup?: boolean;
    signal?: AbortSignal;
    abortProcessTree?: boolean;
  }
): Promise<ShellResult> {
  const mergedEnv = {
    ...cleanEnv(),
    ...options?.env,
    PATH: enrichPath(),
    HOME: homedir(),
  } as unknown as NodeJS.ProcessEnv;

  // killProcessGroup=true: spawn detached so we can kill(-pid) the entire tree
  // (git → hook → check.ts → vitest workers) on timeout or parent exit.
  // abortProcessTree does the same for AbortSignal-driven commands whose
  // direct child can spawn hooks/subprocesses that must not outlive the abort.
  // Abort-aware commands also use spawn so an in-flight step can be cancelled.
  if (options?.killProcessGroup || options?.signal || options?.abortProcessTree) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutMs = options?.timeout ?? 15000;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;

      let child: ReturnType<typeof spawn> | null = null;
      let aborted = false;

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
        resolve({ stdout, stderr, exitCode });
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
      } catch (error) {
        stderr = error instanceof Error ? error.message : String(error);
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

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code, signal) => {
        if (aborted || signal) {
          settle(130);
          return;
        }
        settle(code ?? 1);
      });
      child.on('error', (error) => {
        stderr = stderr || (error instanceof Error ? error.message : String(error));
        settle(1);
      });

      // Don't keep the Node event loop alive just for this child
      if (killTree) child.unref();
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
