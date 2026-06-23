import { homedir } from 'os';
import { join } from 'path';

const extraPaths = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'Library', 'pnpm'),
  join(homedir(), '.nvm', 'versions', 'node'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

export interface ChildEnvOptions {
  scrubSecrets?: boolean;
}

function isCredentialLikeEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper === 'GITHUB_TOKEN' || upper === 'GH_TOKEN' || upper === 'GIT_ASKPASS') return true;
  if (upper === 'SSH_AUTH_SOCK' || upper === 'SSH_AGENT_PID') return true;
  if (upper === 'NETRC' || upper === 'DOCKER_CONFIG') return true;
  if (upper.includes('TOKEN') || upper.includes('SECRET') || upper.includes('PASSWORD')) return true;
  if (upper.endsWith('_KEY') || upper.includes('API_KEY')) return true;
  if (upper.startsWith('AWS_') || upper.startsWith('GCP_') || upper.startsWith('GOOGLE_')) return true;
  if (upper.startsWith('NPM_CONFIG_')) return true;
  return upper === 'NPM_TOKEN' || upper === 'NODE_AUTH_TOKEN';
}

function shouldStripChildEnvKey(key: string, options?: ChildEnvOptions): boolean {
  if (key.startsWith('npm_') || key.startsWith('PNPM_') || key === 'NODE_PATH') return true;
  if (key === 'PORT' || key === 'HOSTNAME') return true;
  if (options?.scrubSecrets && isCredentialLikeEnvKey(key)) return true;
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

export function buildChildEnv(
  overrides?: Record<string, string | undefined>,
  options?: ChildEnvOptions,
): NodeJS.ProcessEnv {
  // Single pass: skip undefined values AND stripped keys during the merge
  // instead of building the full env, layering overrides, and then deleting
  // stripped keys in a third walk.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (shouldStripChildEnvKey(key, options)) continue;
    env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      if (shouldStripChildEnvKey(key, options)) continue;
      env[key] = value;
    }
  }

  env.PATH = enrichPath(env.PATH || '');
  env.HOME = homedir();

  return env as unknown as NodeJS.ProcessEnv;
}
