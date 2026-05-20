import { homedir } from 'os';
import { join } from 'path';

const extraPaths = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'Library', 'pnpm'),
  join(homedir(), '.nvm', 'versions', 'node'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

function shouldStripChildEnvKey(key: string): boolean {
  if (key.startsWith('npm_') || key.startsWith('PNPM_') || key === 'NODE_PATH') return true;
  if (key === 'PORT' || key === 'HOSTNAME') return true;
  return key.startsWith('CODEX_SANDBOX_');
}

function enrichPath(basePath: string): string {
  const additions = extraPaths.filter((p) => !basePath.includes(p));
  return [...additions, basePath].filter(Boolean).join(':');
}

export function buildChildEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) env[key] = value;
  }

  for (const key of Object.keys(env)) {
    if (shouldStripChildEnvKey(key)) delete env[key];
  }

  env.PATH = enrichPath(env.PATH || '');
  env.HOME = homedir();

  return env as unknown as NodeJS.ProcessEnv;
}
