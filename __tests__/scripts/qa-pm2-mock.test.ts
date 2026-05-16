import { describe, it, expect } from 'vitest';
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
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      const raw = readFileSync(statePath, 'utf-8');
      if (raw.length > 0) {
        try {
          const state = JSON.parse(raw);
          if (predicate(state[name])) {
            return state[name];
          }
        } catch {
          // state file is mid-write; retry
        }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Timed out waiting for ${name} in ${statePath}`);
}

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pm2-mock-'));
  return { dir, statePath: join(dir, 'state.json') };
}

describe.concurrent('scripts/qa-mocks/pm2', () => {
  it('runs Node scripts through --interpreter node and records their exit code', async () => {
    const { dir, statePath } = makeDir();
    try {
      const marker = join(dir, 'node-ran.txt');
      const script = join(dir, 'runner.js');
      writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(','));\n`);

      const started = runPm2(['start', script, '--name', 'node-job', '--interpreter', 'node', '--', 'a', 'b'], statePath, dir);

      expect(started.status).toBe(0);
      expect(started.stdout).toContain('[qa-pm2] started node-job');
      const entry = await waitForState(statePath, 'node-job', (state) => state?.status === 'stopped');
      expect(entry.exit_code).toBe(0);
      expect(readFileSync(marker, 'utf-8')).toBe('a,b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes shebang scripts directly when no interpreter is specified', async () => {
    const { dir, statePath } = makeDir();
    try {
      const marker = join(dir, 'shell-ran.txt');
      const script = join(dir, 'release-monitor.sh');
      writeFileSync(script, `#!/bin/sh\nprintf 'ok\\n' > ${JSON.stringify(marker)}\n`);
      chmodSync(script, 0o755);

      const started = runPm2(['start', script, '--name', 'release-monitor', '--no-autorestart'], statePath, dir);

      expect(started.status).toBe(0);
      expect(started.stdout).toContain('[qa-pm2] started release-monitor');
      const entry = await waitForState(statePath, 'release-monitor', (state) => state?.status === 'stopped');
      expect(entry.exit_code).toBe(0);
      expect(readFileSync(marker, 'utf-8').trim()).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns from start while a direct executable is still running', async () => {
    const { dir, statePath } = makeDir();
    try {
      const script = join(dir, 'long-monitor.sh');
      writeFileSync(script, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
      chmodSync(script, 0o755);

      const startedAt = Date.now();
      const started = runPm2(['start', script, '--name', 'long-release-monitor'], statePath, dir);

      expect(started.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(500);
      const jlist = runPm2(['jlist'], statePath, dir);
      expect(jlist.status).toBe(0);
      expect(JSON.parse(jlist.stdout)[0]).toMatchObject({
        name: 'long-release-monitor',
        pm2_env: { status: 'online', exit_code: null },
      });
      runPm2(['delete', 'long-release-monitor'], statePath, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects state written after waiting begins', async () => {
    const { dir, statePath } = makeDir();
    const waiter = waitForState(statePath, 'late-job', (state) => state?.status === 'stopped');

    try {
      setTimeout(() => {
        writeFileSync(statePath, JSON.stringify({
          'late-job': { status: 'stopped', exit_code: 0 },
        }));
      }, 20);

      await expect(waiter).resolves.toMatchObject({ status: 'stopped', exit_code: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
