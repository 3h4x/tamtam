import { homedir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildChildEnv } from '@/lib/shared/child-env';

describe('buildChildEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('strips blocked keys after merging process env and overrides', () => {
    vi.stubEnv('npm_config_user_agent', 'pnpm');
    vi.stubEnv('PNPM_HOME', '/tmp/pnpm');
    vi.stubEnv('NODE_PATH', '/tmp/node-path');
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('HOSTNAME', 'sandbox-host');
    vi.stubEnv('CODEX_SANDBOX_NETWORK_DISABLED', '1');
    vi.stubEnv('KEEP_FROM_PROCESS', 'kept');

    const env = buildChildEnv({
      PNPM_FILTER: 'app',
      CODEX_SANDBOX_OVERRIDE: '1',
      PORT: '4000',
      KEEP_FROM_OVERRIDE: 'also-kept',
    });

    expect(env.npm_config_user_agent).toBeUndefined();
    expect(env.PNPM_HOME).toBeUndefined();
    expect(env.PNPM_FILTER).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.HOSTNAME).toBeUndefined();
    expect(env.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
    expect(env.CODEX_SANDBOX_OVERRIDE).toBeUndefined();
    expect(env.KEEP_FROM_PROCESS).toBe('kept');
    expect(env.KEEP_FROM_OVERRIDE).toBe('also-kept');
  });

  it('prepends standard tool paths without duplicating ones already present', () => {
    const localBin = join(homedir(), '.local', 'bin');
    const basePath = `${localBin}:/usr/bin`;

    const env = buildChildEnv({ PATH: basePath });
    const pathEntries = env.PATH?.split(':') ?? [];

    expect(pathEntries.filter((entry) => entry === localBin)).toHaveLength(1);
    expect(pathEntries).toContain('/opt/homebrew/bin');
    expect(pathEntries).toContain('/usr/local/bin');
    expect(env.PATH?.endsWith(basePath)).toBe(true);
  });

  it('forces HOME back to the current user home even when overrides provide a different value', () => {
    const env = buildChildEnv({ HOME: '/tmp/not-the-real-home' });
    expect(env.HOME).toBe(homedir());
  });

  it('strips credential-like values when scrubSecrets is enabled', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'aws-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
    vi.stubEnv('NPM_CONFIG_USERCONFIG', '/Users/me/.npmrc');
    vi.stubEnv('KEEP_ME', 'safe');

    const env = buildChildEnv({
      NODE_AUTH_TOKEN: 'npm-secret',
      CUSTOM_PASSWORD: 'pw',
      KEEP_OVERRIDE: 'safe-too',
    }, { scrubSecrets: true });

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(env.CUSTOM_PASSWORD).toBeUndefined();
    expect(env.KEEP_ME).toBe('safe');
    expect(env.KEEP_OVERRIDE).toBe('safe-too');
  });
});
