import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const shellExecMock = vi.hoisted(() => vi.fn());
const DEV_DIR = mkdtempSync(join(tmpdir(), 'tamtam-dev-servers-'));
const realSetImmediate = setImmediate;

process.env.TAMTAM_DEV_SERVERS_DIR = DEV_DIR;

vi.mock('@/lib/dev-server/active-work', () => ({
  hasActiveWorkForProject: (project: string) => activeWorkMock(project),
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: shellExecMock,
}));

const PROJECT = 'lifecycle-test-project';
const PIDFILE = join(DEV_DIR, `${PROJECT}.pid`);

const baseConfig: DevServerConfig = {
  // 30s sleep keeps the process alive across the test's quick assertions
  // without leaking if the cleanup hook fails (worst case it dies in 30s).
  startCommand: 'sleep 30',
  stopCommand: null,
  readyUrl: null,
  cwd: process.cwd(),
};

async function ensureWithGrace(
  project: string,
  config: DevServerConfig,
  options?: Parameters<typeof ensureDevServerRunning>[2],
) {
  vi.useFakeTimers();
  try {
    const promise = ensureDevServerRunning(project, config, options);
    await vi.advanceTimersByTimeAsync(1_600);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

async function ensureWithGraceAndIoTurns(
  project: string,
  config: DevServerConfig,
  options?: Parameters<typeof ensureDevServerRunning>[2],
) {
  vi.useFakeTimers();
  try {
    let settled = false;
    let result: Awaited<ReturnType<typeof ensureDevServerRunning>> | undefined;
    let failure: unknown;
    const promise = ensureDevServerRunning(project, config, options).then(
      (value) => {
        settled = true;
        result = value;
      },
      (error) => {
        settled = true;
        failure = error;
      },
    );

    for (let i = 0; i < 40 && !settled; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await new Promise<void>((resolve) => realSetImmediate(resolve));
    }

    if (!settled) {
      await vi.runAllTimersAsync();
      await new Promise<void>((resolve) => realSetImmediate(resolve));
    }

    await promise;
    if (failure) throw failure;
    return result!;
  } finally {
    vi.useRealTimers();
  }
}

async function fullStop(): Promise<void> {
  await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
  if (existsSync(PIDFILE)) {
    try { unlinkSync(PIDFILE); } catch {}
  }
}

async function stopWithIoTurns(
  project: string,
  config: Parameters<typeof stopDevServer>[1],
) {
  vi.useFakeTimers();
  try {
    const promise = stopDevServer(project, config);
    await vi.advanceTimersByTimeAsync(6_000);
    return await promise;
  } finally {
    vi.useRealTimers();
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
    shellExecMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    await fullStop();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await fullStop();
  });

  afterAll(() => {
    delete process.env.TAMTAM_DEV_SERVERS_DIR;
    rmSync(DEV_DIR, { recursive: true, force: true });
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
    const result = await ensureWithGrace(PROJECT, baseConfig, {
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
    const first = await ensureWithGrace(PROJECT, baseConfig);
    expect(first.status).toBe('started');
    const firstPid = first.status === 'started' ? first.pidfile.pid : -1;

    const second = await ensureDevServerRunning(PROJECT, baseConfig);
    expect(second.status).toBe('already_running');
    const secondPid = second.status === 'already_running' ? second.pidfile.pid : -1;
    expect(secondPid).toBe(firstPid);
  });

  it('stopDevServer kills the process and removes the pidfile', async () => {
    const ensured = await ensureWithGrace(PROJECT, baseConfig);
    expect(ensured.status).toBe('started');
    const pid = ensured.status === 'started' ? ensured.pidfile.pid : -1;

    const result = await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
    expect(result.status).toBe('stopped');
    expect(existsSync(PIDFILE)).toBe(false);
    expect(isDevServerRunning(PROJECT)).toBe(false);

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it('stopDevServer reports not_running when no pidfile exists', async () => {
    const result = await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
    expect(result.status).toBe('not_running');
  });

  it('falls back to process-group termination when the configured stop command fails', async () => {
    shellExecMock.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ensured = await ensureWithGrace(PROJECT, baseConfig);
    expect(ensured.status).toBe('started');
    const pid = ensured.status === 'started' ? ensured.pidfile.pid : -1;

    try {
      const result = await stopWithIoTurns(PROJECT, { stopCommand: 'pnpm dev:stop', cwd: process.cwd() });
      expect(result).toEqual({ status: 'stopped', pid });
      expect(shellExecMock).toHaveBeenCalledWith('bash', ['-c', 'pnpm dev:stop'], {
        cwd: process.cwd(),
        timeout: 15_000,
        killProcessGroup: true,
      });
      expect(existsSync(PIDFILE)).toBe(false);
      expect(isAlive(pid)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(`[dev-server] stop command failed for ${PROJECT}: boom`);
    } finally {
      warnSpy.mockRestore();
    }
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

    const result = await ensureWithGrace(PROJECT, baseConfig);
    expect(result.status).toBe('started');
    const pid = result.status === 'started' ? result.pidfile.pid : -1;
    expect(pid).not.toBe(deadPid);
    expect(pid).toBeGreaterThan(0);
  });

  it('does not trust a live pidfile whose process identity does not match', async () => {
    const foreign = spawnForeignProcess();
    try {
      writeUntrustedLivePidfile(PROJECT, foreign);

      const result = await ensureWithGrace(PROJECT, baseConfig);
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
      const result = await ensureWithGrace(project, baseConfig);
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

  it('sweepOrphanDevServers stops an orphan using the persisted project config', async () => {
    const project = 'lifecycle-sweep-orphan';
    const dbPath = '/tmp/dev-server-from-db';
    const dbWhereMock = vi.fn().mockResolvedValue([{
      devServerStartCommand: 'pnpm dev',
      devServerStopCommand: 'pnpm dev:stop',
      devServerReadyUrl: 'http://example.test/ready',
      path: dbPath,
    }]);
    const dbFromMock = vi.fn(() => ({ where: dbWhereMock }));
    const selectMock = vi.fn(() => ({ from: dbFromMock }));
    const eqMock = vi.fn(() => 'predicate');

    vi.doMock('@/lib/db', () => ({
      db: { select: selectMock },
      schema: { projects: { name: 'projects.name' } },
    }));
    vi.doMock('drizzle-orm', () => ({ eq: eqMock }));

    try {
      const result = await ensureWithGrace(project, baseConfig);
      expect(result.status).toBe('started');

      const sweep = await sweepOrphanDevServers();

      expect(sweep.stopped).toContain(project);
      expect(sweep.kept).not.toContain(project);
      expect(shellExecMock).toHaveBeenCalledWith('bash', ['-c', 'pnpm dev:stop'], {
        cwd: dbPath,
        timeout: 15_000,
        killProcessGroup: true,
      });
      expect(eqMock).toHaveBeenCalledWith('projects.name', project);
      expect(dbWhereMock).toHaveBeenCalledWith('predicate');
      expect(existsSync(pidfilePath(project))).toBe(false);
      expect(isDevServerRunning(project)).toBe(false);
    } finally {
      vi.doUnmock('@/lib/db');
      vi.doUnmock('drizzle-orm');
      await stopDevServer(project, { stopCommand: null, cwd: dbPath });
      const path = pidfilePath(project);
      if (existsSync(path)) {
        try { unlinkSync(path); } catch {}
      }
    }
  });

  it('treats a readyUrl that already responds as an externally owned dev server', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      readyUrl: 'http://example.test/ready',
    });

    expect(result).toMatchObject({
      status: 'already_running',
      pidfile: {
        pid: -1,
        pgid: -1,
        command: '(external)',
        readyUrl: 'http://example.test/ready',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(PIDFILE)).toBe(false);
  });

  it('treats non-5xx readiness responses as externally owned dev servers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      readyUrl: 'http://example.test/ready',
    });

    expect(result).toMatchObject({
      status: 'already_running',
      pidfile: {
        pid: -1,
        pgid: -1,
        command: '(external)',
        readyUrl: 'http://example.test/ready',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(PIDFILE)).toBe(false);
  });

  it('does not treat 5xx readiness responses as externally owned dev servers', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    const promise = ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      readyUrl: 'http://example.test/ready',
    }, {
      readyTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    const result = await promise;

    expect(result.status).toBe('ready_timeout');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(existsSync(PIDFILE)).toBe(true);

    vi.useRealTimers();
    await fullStop();
  });

  it('returns ready_timeout when the spawned server never reaches readiness', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('not ready'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      readyUrl: 'http://example.test/ready',
    }, {
      readyTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    const result = await promise;

    expect(result.status).toBe('ready_timeout');
    expect(fetchMock).toHaveBeenCalled();
    expect(existsSync(PIDFILE)).toBe(true);

    vi.useRealTimers();
    await fullStop();
  });

  it('cleans up synthetic external pidfiles without reporting the server as running', async () => {
    writeFileSync(PIDFILE, JSON.stringify({
      project: PROJECT,
      pid: -1,
      pgid: -1,
      processStart: null,
      startedAt: Date.now() - 10_000,
      startedByJobId: null,
      command: '(external)',
      readyUrl: 'http://example.test/ready',
      cwd: process.cwd(),
      logPath: '',
    }));

    expect(isDevServerRunning(PROJECT)).toBe(false);

    const result = await stopDevServer(PROJECT, { stopCommand: null, cwd: process.cwd() });
    expect(result.status).toBe('not_running');
    expect(existsSync(PIDFILE)).toBe(false);
  });

  it('returns spawn_failed when the command exits immediately', async () => {
    const result = await ensureDevServerRunning(PROJECT, {
      ...baseConfig,
      startCommand: 'true', // exits 0 immediately
    });
    expect(result.status).toBe('spawn_failed');
    expect(existsSync(PIDFILE)).toBe(false);
  });

  it('returns spawn_failed when a command with readyUrl exits before readiness', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('not ready'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureWithGraceAndIoTurns(PROJECT, {
      ...baseConfig,
      startCommand: 'true',
      readyUrl: 'http://example.test/ready',
    }, {
      readyTimeoutMs: 5_000,
    });

    expect(result.status).toBe('spawn_failed');
    expect(fetchMock).toHaveBeenCalled();
    expect(existsSync(PIDFILE)).toBe(false);
  });

  it('isDevServerRunning is false when no pidfile', () => {
    expect(isDevServerRunning(PROJECT)).toBe(false);
  });
});
