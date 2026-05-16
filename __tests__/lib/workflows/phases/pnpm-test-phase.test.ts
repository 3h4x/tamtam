import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeJobStubs(overrides: Partial<{ logDir: string; detectedCmd: string | null; projPath: string | null }> = {}) {
  const logDir = overrides.logDir ?? mkdtempSync(join(tmpdir(), 'plain-test-'));
  const job = {
    id: 'proj-test-1',
    project: 'proj',
    kind: 'test',
    pid: 0,
    finishedAt: null as number | null,
    exitCode: null as number | null,
    logPath: '',
  };
  const createJob = vi.fn().mockReturnValue(job);
  const updateJob = vi.fn();
  const markDone = vi.fn().mockImplementation(async (j: typeof job, exitCode: number) => {
    j.finishedAt = 1;
    j.exitCode = exitCode;
  });
  const detectTestCommand = vi.fn().mockResolvedValue('detectedCmd' in overrides ? overrides.detectedCmd : 'echo running tests');
  const resolveProjectPath = vi.fn().mockReturnValue('projPath' in overrides ? overrides.projPath : '/tmp/proj');
  const safeStartOrchestrator = vi.fn().mockResolvedValue(undefined);

  return { logDir, job, createJob, updateJob, markDone, detectTestCommand, resolveProjectPath, safeStartOrchestrator };
}

function wire(stubs: ReturnType<typeof makeJobStubs>, execMock: ReturnType<typeof vi.fn>) {
  vi.doMock('@/lib/jobs/job-storage', () => ({
    createJob: stubs.createJob,
    updateJob: stubs.updateJob,
    markDone: stubs.markDone,
  }));
  vi.doMock('@/lib/pipeline/start-test', () => ({ detectTestCommand: stubs.detectTestCommand }));
  vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: stubs.resolveProjectPath }));
  vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
  vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir: stubs.logDir }) }));
  vi.doMock('@/lib/jobs/parent-context', () => ({ runWithParent: <T,>(_id: string, fn: () => T) => fn() }));
  vi.doMock('@/lib/workflows/safe-start-orchestrator', () => ({ safeStartOrchestrator: stubs.safeStartOrchestrator }));
}

describe('pnpmTestPhaseWorkflow', () => {
  let cleanup: string[] = [];
  beforeEach(() => { vi.resetModules(); cleanup = []; });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('runs the detected test command, captures output to a log, and reports exit 0', async () => {
    const stubs = makeJobStubs();
    cleanup.push(stubs.logDir);
    const execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'all green\n', stderr: '' });
    wire(stubs, execMock);

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(execMock).toHaveBeenCalledWith('sh', ['-c', 'echo running tests'], expect.objectContaining({ cwd: '/tmp/proj' }));
    expect(stubs.markDone).toHaveBeenCalledWith(stubs.job, 0);
    expect(stubs.safeStartOrchestrator).toHaveBeenCalledWith('proj-test-1', 'proj', 'release-1', 'pnpm-test-phase');

    const log = readFileSync(stubs.job.logPath, 'utf-8');
    expect(log).toContain('echo running tests');
    expect(log).toContain('all green');
    expect(log).toContain('# exit 0');
  });

  it('marks the job with non-zero exit and still writes a log', async () => {
    const stubs = makeJobStubs();
    cleanup.push(stubs.logDir);
    const execMock = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '1 test failed', stderr: 'AssertionError' });
    wire(stubs, execMock);

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r.exitCode).toBe(1);
    expect(stubs.markDone).toHaveBeenCalledWith(stubs.job, 1);
    const log = readFileSync(stubs.job.logPath, 'utf-8');
    expect(log).toContain('1 test failed');
    expect(log).toContain('AssertionError');
    expect(log).toContain('# exit 1');
  });

  it('bails when no test command is detected', async () => {
    const stubs = makeJobStubs({ detectedCmd: null });
    cleanup.push(stubs.logDir);
    const execMock = vi.fn();
    wire(stubs, execMock);

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('proj', 'release-1');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_command');
    expect(execMock).not.toHaveBeenCalled();
    expect(stubs.createJob).not.toHaveBeenCalled();
  });

  it('bails when project path cannot be resolved', async () => {
    const stubs = makeJobStubs({ projPath: null });
    cleanup.push(stubs.logDir);
    const execMock = vi.fn();
    wire(stubs, execMock);

    const { pnpmTestPhaseWorkflow } = await import('@/lib/workflows/phases/pnpm-test-phase');
    const r = await pnpmTestPhaseWorkflow('missing', 'release-1');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('start_failed');
    expect(execMock).not.toHaveBeenCalled();
  });
});
