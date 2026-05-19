import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureDevServerRunning,
  stopDevServer,
  isDevServerRunning,
  readPidfile,
  sweepOrphanDevServers,
  type DevServerConfig,
} from '@/lib/dev-server/lifecycle';

const activeWorkMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/dev-server/active-work', () => ({
  hasActiveWorkForProject: (project: string) => activeWorkMock(project),
}));

const PROJECT = 'lifecycle-test-project';
const DEV_DIR = join(process.cwd(), 'data', 'dev-servers');
const PIDFILE = join(DEV_DIR, `${PROJECT}.pid`);

const baseConfig: DevServerConfig = {
  // 30s sleep keeps the process alive across the test's quick assertions
  // without leaking if the cleanup hook fails (worst case it dies in 30s).
  startCommand: 'sleep 30',
  stopCommand: null,
  readyUrl: null,
  cwd: process.cwd(),
};

async function fullStop(): Promise<void> {
  await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
  if (existsSync(PIDFILE)) {
    try { unlinkSync(PIDFILE); } catch {}
  }
}

function pidfilePath(project: string): string {
  const safe = project.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(DEV_DIR, `${safe}.pid`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnForeignProcess(): ChildProcess {
  const child = spawn('sleep', ['30'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (!child.pid) throw new Error('foreign process did not expose pid');
  return child;
}

function killForeignProcess(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
}

function writeUntrustedLivePidfile(project: string, child: ChildProcess): string {
  if (!child.pid) throw new Error('foreign process did not expose pid');
  if (!existsSync(DEV_DIR)) mkdirSync(DEV_DIR, { recursive: true });
  const path = join(DEV_DIR, `${project}.pid`);
  writeFileSync(path, JSON.stringify({
    project,
    pid: child.pid,
    pgid: child.pid,
    processStart: 'not-the-recorded-start-time',
    startedAt: Date.now() - 10_000,
    startedByJobId: 'old-job',
    command: 'old-sleep',
    readyUrl: null,
    cwd: process.cwd(),
    logPath: '',
  }));
  return path;
}

describe('dev-server lifecycle', () => {
  beforeEach(async () => {
    activeWorkMock.mockReset().mockResolvedValue(false);
    await fullStop();
  });

  afterEach(async () => {
    await fullStop();
  });

  it('returns no_config when startCommand is null', async () => {
    const result = await ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      startCommand: null,
    });
    expect(result.status).toBe('no_config');
    expect(existsSync(PIDFILE)).toBe(false);
  });

  it('returns no_config when startCommand is whitespace', async () => {
    const result = await ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      startCommand: '   ',
    });
    expect(result.status).toBe('no_config');
  });

  it('spawns the process, writes a pidfile, reports started', async () => {
    const result = await ensureDevServerRunning(PROJECT, baseConfig, {
      startedByJobId: 'job-abc',
    });
    expect(result.status).toBe('started');
    expect(existsSync(PIDFILE)).toBe(true);
    const pidfile = readPidfile(PROJECT);
    expect(pidfile).not.toBeNull();
    expect(pidfile!.pid).toBeGreaterThan(0);
    expect(pidfile!.project).toBe(PROJECT);
    expect(typeof pidfile!.processStart === 'string' || pidfile!.processStart === null).toBe(true);
    expect(pidfile!.startedByJobId).toBe('job-abc');
    expect(pidfile!.command).toBe('sleep 30');
    expect(isDevServerRunning(PROJECT)).toBe(true);
  });

  it('is idempotent: second ensure returns already_running with same pid', async () => {
    const first = await ensureDevServerRunning(PROJECT, baseConfig);
    expect(first.status).toBe('started');
    const firstPid = first.status === 'started' ? first.pidfile.pid : -1;

    const second = await ensureDevServerRunning(PROJECT, baseConfig);
    expect(second.status).toBe('already_running');
    const secondPid = second.status === 'already_running' ? second.pidfile.pid : -1;
    expect(secondPid).toBe(firstPid);
  });

  it('stopDevServer kills the process and removes the pidfile', async () => {
    const ensured = await ensureDevServerRunning(PROJECT, baseConfig);
    expect(ensured.status).toBe('started');
    const pid = ensured.status === 'started' ? ensured.pidfile.pid : -1;

    const result = await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
    expect(result.status).toBe('stopped');
    expect(existsSync(PIDFILE)).toBe(false);
    expect(isDevServerRunning(PROJECT)).toBe(false);

    // Process really gone — give the kill a beat to settle.
    await new Promise((r) => setTimeout(r, 100));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it('stopDevServer reports not_running when no pidfile exists', async () => {
    const result = await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
    expect(result.status).toBe('not_running');
  });

  it('cleans up a stale pidfile (dead pid) and respawns fresh', async () => {
    if (!existsSync(DEV_DIR)) mkdirSync(DEV_DIR, { recursive: true });
    // PID 1 is init; we can't kill it but it IS alive. Use a pid known to be
    // unused: pick a high pid that almost certainly doesn't exist.
    // (Test would falsely fail on a system where this pid happens to be a
    // running process; the probability is vanishingly small.)
    const deadPid = 999_999;
    writeFileSync(PIDFILE, JSON.stringify({
      pid: deadPid,
      pgid: deadPid,
      startedAt: Date.now() - 10_000,
      startedByJobId: 'old-job',
      command: 'old-sleep',
      readyUrl: null,
      cwd: process.cwd(),
      logPath: '',
    }));

    const result = await ensureDevServerRunning(PROJECT, baseConfig);
    expect(result.status).toBe('started');
    const pid = result.status === 'started' ? result.pidfile.pid : -1;
    expect(pid).not.toBe(deadPid);
    expect(pid).toBeGreaterThan(0);
  });

  it('does not trust a live pidfile whose process identity does not match', async () => {
    const foreign = spawnForeignProcess();
    try {
      writeUntrustedLivePidfile(PROJECT, foreign);

      const result = await ensureDevServerRunning(PROJECT, baseConfig);
      expect(result.status).toBe('started');
      expect(isAlive(foreign.pid!)).toBe(true);
      const pidfile = readPidfile(PROJECT);
      expect(pidfile).not.toBeNull();
      expect(pidfile!.pid).not.toBe(foreign.pid);
      expect(pidfile!.processStart).not.toBe('not-the-recorded-start-time');
    } finally {
      killForeignProcess(foreign);
    }
  });

  it('does not stop a live process referenced by an untrusted pidfile', async () => {
    const foreign = spawnForeignProcess();
    try {
      writeUntrustedLivePidfile(PROJECT, foreign);

      const result = await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
      expect(result.status).toBe('not_running');
      expect(existsSync(PIDFILE)).toBe(false);
      expect(isAlive(foreign.pid!)).toBe(true);
    } finally {
      killForeignProcess(foreign);
    }
  });

  it('sweepOrphanDevServers removes an untrusted live pidfile without signaling the process', async () => {
    const project = 'lifecycle-sweep-untrusted';
    const path = join(DEV_DIR, `${project}.pid`);
    const foreign = spawnForeignProcess();
    try {
      writeUntrustedLivePidfile(project, foreign);

      const result = await sweepOrphanDevServers();
      expect(result.stopped).not.toContain(project);
      expect(existsSync(path)).toBe(false);
      expect(isAlive(foreign.pid!)).toBe(true);
    } finally {
      if (existsSync(path)) {
        try { unlinkSync(path); } catch {}
      }
      killForeignProcess(foreign);
    }
  });

  it('sweepOrphanDevServers keeps an active project whose pidfile name is sanitized', async () => {
    const project = 'lifecycle sweep project';
    const path = pidfilePath(project);
    activeWorkMock.mockImplementation((name: string) => Promise.resolve(name === project));
    try {
      const result = await ensureDevServerRunning(project, baseConfig);
      expect(result.status).toBe('started');

      const sweep = await sweepOrphanDevServers();
      expect(activeWorkMock).toHaveBeenCalledWith(project);
      expect(sweep.kept).toContain(project);
      expect(sweep.stopped).not.toContain(project.replace(/[^a-zA-Z0-9._-]/g, '_'));
      expect(existsSync(path)).toBe(true);
      expect(isDevServerRunning(project)).toBe(true);
    } finally {
      await stopDevServer(project, { stopCommand: null, cwd: process.cwd() });
      if (existsSync(path)) {
        try { unlinkSync(path); } catch {}
      }
    }
  });

  it('returns spawn_failed when the command exits immediately', async () => {
    const result = await ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      startCommand: 'true', // exits 0 immediately
    });
    expect(result.status).toBe('spawn_failed');
    expect(existsSync(PIDFILE)).toBe(false);
  });

  it('isDevServerRunning is false when no pidfile', () => {
    expect(isDevServerRunning(PROJECT)).toBe(false);
  });
});
