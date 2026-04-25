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
    env[key] = value;
  }
  return env;
}

export function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string>; killProcessGroup?: boolean }
): Promise<ShellResult> {
  const mergedEnv = {
    ...cleanEnv(),
    ...options?.env,
    PATH: enrichPath(),
    HOME: homedir(),
  } as unknown as NodeJS.ProcessEnv;

  // killProcessGroup=true: spawn detached so we can kill(-pid) the entire tree
  // (git → hook → check.ts → vitest workers) on timeout or parent exit.
  if (options?.killProcessGroup) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: options?.cwd,
        env: mergedEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutMs = options?.timeout ?? 15000;

      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid) {
          try { process.kill(-child.pid, sig); } catch {}
        }
      };

      const settle = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({ stdout, stderr, exitCode });
      };

      const killTimer = setTimeout(() => {
        killGroup('SIGTERM');
        // Escalate to SIGKILL if SIGTERM doesn't land (e.g. process ignores it)
        setTimeout(() => killGroup('SIGKILL'), 5000);
        settle(1);
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => settle(code ?? 1));
      child.on('error', () => settle(1));

      // Don't keep the Node event loop alive just for this child
      child.unref();
    });
  }

  return new Promise((resolve) => {
    const opts: ExecFileOptions = {
      cwd: options?.cwd,
      timeout: options?.timeout ?? 15000,
      env: mergedEnv,
      maxBuffer: 10 * 1024 * 1024,
    };

    execFile(cmd, args, opts, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout ?? '').toString(),
        stderr: (stderr ?? '').toString(),
        exitCode: error ? (Number((error as NodeJS.ErrnoException).code) || 1) : 0,
      });
    });
  });
}
