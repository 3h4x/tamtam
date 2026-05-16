import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeJob(overrides: Partial<{
  exitCode: number | null;
  finishedAt: number | null;
  logPath: string;
}> = {}) {
  return {
    id: 'proj-test-1',
    project: 'proj',
    kind: 'test',
    pid: 12345,
    finishedAt: overrides.finishedAt ?? 1,
    exitCode: overrides.exitCode ?? 0,
    logPath: overrides.logPath ?? '/tmp/proj-test-1.log',
  };
}

function wire(overrides: Partial<{
  startResult: unknown;
  waitResult: unknown;
}> = {}) {
  const startProjectTest = vi.fn().mockResolvedValue(
    overrides.startResult ?? {
      ok: true,
      jobId: 'proj-test-1',
      pid: 12345,
      logPath: '/tmp/proj-test-1.log',
      testCmd: 'pnpm test',
    },
  );
  const waitForJobCompletion = vi.fn().mockResolvedValue(
    overrides.waitResult ?? {
      job: makeJob(),
      finished: true,
      reason: 'finished',
    },
  );
  const runWithParent = vi.fn((_id: string, fn: () => unknown) => fn());
  const safeStartOrchestrator = vi.fn().mockResolvedValue(undefined);

  vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest }));
  vi.doMock('@/lib/workflows/wait-for-job', () => ({ waitForJobCompletion }));
  vi.doMock('@/lib/jobs/parent-context', () => ({ runWithParent }));
  vi.doMock('@/lib/workflows/safe-start-orchestrator', () => ({ safeStartOrchestrator }));
  vi.doMock('@/lib/shared/shell', () => ({
    exec: vi.fn(() => {
      throw new Error('plain test phase must not buffer test output through exec');
    }),
  }));

  return { startProjectTest, waitForJobCompletion, runWithParent, safeStartOrchestrator };
}

describe('pnpmTestPhaseWorkflow', () => {
  let cleanup: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    cleanup = [];
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('delegates to startProjectTest, waits for completion, and dispatches the orchestrator tick', async () => {
    const mocks = wire();

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r).toEqual({
      ok: true,
      jobId: 'proj-test-1',
      exitCode: 0,
      reason: 'finished',
    });
    expect(mocks.runWithParent).toHaveBeenCalledWith('release-1', expect.any(Function));
    expect(mocks.startProjectTest).toHaveBeenCalledWith('proj');
    expect(mocks.waitForJobCompletion).toHaveBeenCalledWith('proj-test-1');
    expect(mocks.safeStartOrchestrator).toHaveBeenCalledWith('proj-test-1', 'proj', 'release-1', 'pnpm-test-phase');
  });

  it('returns no_command when the shared test runner cannot detect a test command', async () => {
    const mocks = wire({
      startResult: {
        ok: false,
        status: 400,
        detail: 'Could not detect test command for proj',
      },
    });

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r).toEqual({
      ok: false,
      jobId: null,
      exitCode: null,
      reason: 'no_command',
      detail: 'Could not detect test command for proj',
    });
    expect(mocks.waitForJobCompletion).not.toHaveBeenCalled();
    expect(mocks.safeStartOrchestrator).not.toHaveBeenCalled();
  });

  it('returns start_failed for other startProjectTest failures', async () => {
    const mocks = wire({
      startResult: {
        ok: false,
        status: 409,
        detail: 'Tests already running for proj',
        blockingJobId: 'test-existing',
      },
    });

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r).toEqual({
      ok: false,
      jobId: null,
      exitCode: null,
      reason: 'start_failed',
      detail: 'Tests already running for proj',
    });
    expect(mocks.waitForJobCompletion).not.toHaveBeenCalled();
  });

  it('does not depend on buffered command output, so logs larger than exec maxBuffer do not fail the phase', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plain-test-large-log-'));
    cleanup.push(tempDir);
    const logPath = join(tempDir, 'proj-test-1.log');
    writeFileSync(logPath, 'x'.repeat(11 * 1024 * 1024));

    wire({
      waitResult: {
        job: makeJob({ logPath, exitCode: 0 }),
        finished: true,
        reason: 'finished',
      },
    });

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('reports timeout without dispatching another orchestrator tick', async () => {
    const mocks = wire({
      waitResult: {
        job: makeJob({ finishedAt: null, exitCode: null }),
        finished: false,
        reason: 'timeout',
      },
    });

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r).toEqual({
      ok: false,
      jobId: 'proj-test-1',
      exitCode: null,
      reason: 'timeout',
    });
    expect(mocks.safeStartOrchestrator).not.toHaveBeenCalled();
  });
});
