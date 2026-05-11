import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const PM2_MOCK = resolve(__dirname, '..', '..', 'scripts', 'qa-mocks', 'pm2');

function runPm2(args: string[], statePath: string, cwd?: string) {
  return spawnSync(PM2_MOCK, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, TAMTAM_QA_PM2_STATE: statePath },
  });
}

async function waitForState(
  statePath: string,
  name: string,
  predicate: (entry: { status?: string; exit_code?: number | null } | undefined) => boolean,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (predicate(state[name])) return state[name];
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${name} in ${statePath}`);
}

describe('scripts/qa-mocks/pm2', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-pm2-mock-'));
    statePath = join(dir, 'state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs Node scripts through --interpreter node and records their exit code', async () => {
    const marker = join(dir, 'node-ran.txt');
    const script = join(dir, 'runner.js');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(','));\n`);

    const started = runPm2(['start', script, '--name', 'node-job', '--interpreter', 'node', '--', 'a', 'b'], statePath, dir);

    expect(started.status).toBe(0);
    expect(started.stdout).toContain('[qa-pm2] started node-job');
    const entry = await waitForState(statePath, 'node-job', (state) => state?.status === 'stopped');
    expect(entry.exit_code).toBe(0);
    expect(readFileSync(marker, 'utf-8')).toBe('a,b');
  });

  it('executes shebang scripts directly when no interpreter is specified', async () => {
    const marker = join(dir, 'shell-ran.txt');
    const script = join(dir, 'release-monitor.sh');
    writeFileSync(script, `#!/bin/bash\necho ok > ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(script, 0o755);

    const started = runPm2(['start', script, '--name', 'release-monitor', '--no-autorestart'], statePath, dir);

    expect(started.status).toBe(0);
    expect(started.stdout).toContain('[qa-pm2] started release-monitor');
    const entry = await waitForState(statePath, 'release-monitor', (state) => state?.status === 'stopped');
    expect(entry.exit_code).toBe(0);
    expect(readFileSync(marker, 'utf-8').trim()).toBe('ok');
  });

  it('returns from start while a direct executable is still running', async () => {
    const script = join(dir, 'long-monitor.sh');
    writeFileSync(script, '#!/bin/bash\nsleep 2\nexit 0\n');
    chmodSync(script, 0o755);

    const startedAt = Date.now();
    const started = runPm2(['start', script, '--name', 'long-release-monitor'], statePath, dir);

    expect(started.status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const jlist = runPm2(['jlist'], statePath, dir);
    expect(jlist.status).toBe(0);
    expect(JSON.parse(jlist.stdout)[0]).toMatchObject({
      name: 'long-release-monitor',
      pm2_env: { status: 'online', exit_code: null },
    });
    runPm2(['delete', 'long-release-monitor'], statePath, dir);
  });
});
