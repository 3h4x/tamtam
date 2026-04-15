import { execFile, ExecFileOptions } from 'child_process';
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
  options?: { cwd?: string; timeout?: number; env?: Record<string, string> }
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const opts: ExecFileOptions = {
      cwd: options?.cwd,
      timeout: options?.timeout ?? 15000,
      env: {
        ...cleanEnv(),
        ...options?.env,
        PATH: enrichPath(),
        HOME: homedir(),
      } as unknown as NodeJS.ProcessEnv,
      maxBuffer: 10 * 1024 * 1024,
    };

    execFile(cmd, args, opts, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout ?? '').toString(),
        stderr: (stderr ?? '').toString(),
        exitCode: error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

export function execSync(
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeout?: number }
): ShellResult {
  const { execFileSync } = require('child_process');
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: options?.cwd,
      timeout: options?.timeout ?? 15000,
      env: {
        ...cleanEnv(),
        PATH: enrichPath(),
        HOME: homedir(),
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      exitCode: e.status ?? 1,
    };
  }
}
