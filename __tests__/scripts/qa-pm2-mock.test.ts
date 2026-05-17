import { describe, it, expect, vi } from 'vitest';
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

function readStateEntry(statePath: string, name: string) {
  if (!existsSync(statePath)) {
    return undefined;
  }
  const raw = readFileSync(statePath, 'utf-8');
  if (raw.length === 0) {
    return undefined;
  }
  try {
    const state = JSON.parse(raw) as Record<string, { status?: string; exit_code?: number | null }>;
    return state[name];
  } catch {
    // state file is mid-write; retry
    return undefined;
  }
}

async function waitForState(
  statePath: string,
  name: string,
  predicate: (entry: { status?: string; exit_code?: number | null } | undefined) => boolean,
): Promise<{ status?: string; exit_code?: number | null }> {
  let entry: { status?: string; exit_code?: number | null } | undefined;
  await vi.waitFor(() => {
    entry = readStateEntry(statePath, name);
    expect(predicate(entry)).toBe(true);
  }, { timeout: 2000, interval: 5 });
  return entry!;
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

  it('does not resurrect a deleted job when its child exits after SIGTERM', async () => {
    const { dir, statePath } = makeDir();
    try {
      const marker = join(dir, 'terminated.txt');
      const script = join(dir, 'terminating-monitor.js');
      writeFileSync(script, [
        "const fs = require('fs');",
        `const marker = ${JSON.stringify(marker)};`,
        "fs.writeFileSync(marker, 'ready');",
        "process.on('SIGTERM', () => { fs.writeFileSync(marker, 'term'); process.exit(0); });",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'));

      const started = runPm2(['start', script, '--name', 'deleted-monitor', '--interpreter', 'node'], statePath, dir);
      expect(started.status).toBe(0);
      await vi.waitFor(() => expect(readFileSync(marker, 'utf-8')).toBe('ready'), { timeout: 2000, interval: 5 });

      const deleted = runPm2(['delete', 'deleted-monitor'], statePath, dir);
      expect(deleted.status).toBe(0);
      await vi.waitFor(() => expect(readFileSync(marker, 'utf-8')).toBe('term'), { timeout: 2000, interval: 5 });
      await vi.waitFor(() => expect(readStateEntry(statePath, 'deleted-monitor')).toBeUndefined(), { timeout: 2000, interval: 5 });

      const jlist = runPm2(['jlist'], statePath, dir);
      expect(jlist.status).toBe(0);
      expect(JSON.parse(jlist.stdout)).toEqual([]);
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
      }, 1);

      await expect(waiter).resolves.toMatchObject({ status: 'stopped', exit_code: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
