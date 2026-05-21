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
  // Exact-entry membership instead of substring includes — `/opt/homebrew/bin`
  // shouldn't be considered "already in PATH" just because a longer path
  // happens to contain it as a substring (e.g. `/foo/opt/homebrew/bin/bar`).
  const existing = new Set(basePath.split(':').filter(Boolean));
  const additions = extraPaths.filter((p) => !existing.has(p));
  return [...additions, basePath].filter(Boolean).join(':');
}

export function buildChildEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // Single pass: skip undefined values AND stripped keys during the merge
  // instead of building the full env, layering overrides, and then deleting
  // stripped keys in a third walk.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (shouldStripChildEnvKey(key)) continue;
    env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      if (shouldStripChildEnvKey(key)) continue;
      env[key] = value;
    }
  }

  env.PATH = enrichPath(env.PATH || '');
  env.HOME = homedir();

  return env as unknown as NodeJS.ProcessEnv;
}
