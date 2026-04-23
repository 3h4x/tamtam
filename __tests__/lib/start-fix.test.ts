import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Minimal fake process returned by the spawn mock.
function makeProc(pid = 12345) {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    pid: number;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null;
    unref: ReturnType<typeof vi.fn>;
  };
  (proc as any).pid = pid;
  (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
  (proc as any).unref = vi.fn();
  return proc;
}

describe('startFixFromJob', () => {
  let startFixFromJob: typeof import('@/lib/start-fix').startFixFromJob;
  let getJobMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let readLogMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let acquireLockMock: ReturnType<typeof vi.fn>;
  let isLockOwnedByActiveReleaseMock: ReturnType<typeof vi.fn>;
  let openSyncMock: ReturnType<typeof vi.fn>;
  let mkdirSyncMock: ReturnType<typeof vi.fn>;

  function makeSourceJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'src-job-1', project: 'myproject', kind: 'review', pid: 111,
      logPath: '/tmp/src-job-1.log', prompt: null,
      startedAt: Date.now() / 1000, finishedAt: 1000, exitCode: 1, seen: false,
      sessionId: null, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0,
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    spawnMock = vi.fn().mockReturnValue(makeProc());
    openSyncMock = vi.fn().mockReturnValue(5); // fake fd
    mkdirSyncMock = vi.fn();
    getJobMock = vi.fn().mockReturnValue(makeSourceJob());
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/myproject');
    readLogMock = vi.fn().mockReturnValue('Error: test failure at line 42\n');
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      sessionId: null,
    }));
    updateJobMock = vi.fn();
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    acquireLockMock = vi.fn().mockResolvedValue({ acquired: true });
    isLockOwnedByActiveReleaseMock = vi.fn().mockReturnValue(false);

    vi.doMock('child_process', () => ({ spawn: spawnMock }));
    vi.doMock('fs', () => ({
      mkdirSync: mkdirSyncMock,
      openSync: openSyncMock,
      closeSync: vi.fn(),
    }));
    vi.doMock('@/lib/job-storage', () => ({
      getJob: getJobMock,
      createJob: createJobMock,
      readLog: readLogMock,
      probeJobStatus: probeJobStatusMock,
      updateJob: updateJobMock,
      markDone: markDoneMock,
    }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp/logs' }),
    }));
    vi.doMock('@/lib/config', () => ({
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: () => ({ default_model: 'sonnet' }),
    }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));

    ({ startFixFromJob } = await import('@/lib/start-fix'));
  });

  afterEach(() => vi.resetModules());

  it('returns 404 when source job does not exist', async () => {
    getJobMock.mockReturnValue(undefined);
    const r = await startFixFromJob('nonexistent');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('nonexistent');
    }
  });

  it('returns 400 when source job is still running', async () => {
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startFixFromJob('src-job-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('still running');
    }
  });

  it('returns 404 when project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const r = await startFixFromJob('src-job-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('project not found');
    }
  });

  it('returns 400 when log output is empty and no sessionId', async () => {
    readLogMock.mockReturnValue('   ');
    const r = await startFixFromJob('src-job-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No output to fix from');
    }
  });

  it('returns ok with jobId and pid on success', async () => {
    const r = await startFixFromJob('src-job-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBe('myproject-fix-id');
      expect(r.pid).toBe(12345);
    }
  });

  it('spawns claude with --print and --output-format stream-json', async () => {
    await startFixFromJob('src-job-1');
    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
  });

  it('uses log output as prompt when no sessionId', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    await startFixFromJob('src-job-1');
    expect(proc.stdin!.write).toHaveBeenCalled();
    const prompt: string = (proc.stdin!.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt).toContain('Error: test failure at line 42');
    expect(prompt).toContain('myproject');
    expect(prompt).toContain('review');
  });

  it('uses short resume prompt when sessionId is present', async () => {
    getJobMock.mockReturnValue(makeSourceJob({ sessionId: 'ses-abc123' }));
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    await startFixFromJob('src-job-1');
    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).toContain('--resume');
    expect(args).toContain('ses-abc123');
    const prompt: string = (proc.stdin!.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt).toContain('Please fix ALL the issues');
    // Should NOT include raw log output
    expect(prompt).not.toContain('Error: test failure');
  });

  it('truncates log output exceeding 12000 chars', async () => {
    const longLog = 'x'.repeat(15000);
    readLogMock.mockReturnValue(longLog);
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    await startFixFromJob('src-job-1');
    const prompt: string = (proc.stdin!.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt).toContain('(truncated)');
  });

  it('acquires pipeline lock after spawning when not under release', async () => {
    await startFixFromJob('src-job-1');
    expect(acquireLockMock).toHaveBeenCalledWith('myproject', 'myproject-fix-id');
  });

  it('does not acquire pipeline lock when under an active release', async () => {
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    await startFixFromJob('src-job-1');
    expect(acquireLockMock).not.toHaveBeenCalled();
  });

  it('marks job done with exit code when process exits', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    await startFixFromJob('src-job-1');
    // Simulate process exit
    (proc as any).emit('exit', 0);
    // Allow microtasks to flush
    await new Promise((r) => setImmediate(r));
    expect(markDoneMock).toHaveBeenCalled();
    const [, exitCode] = markDoneMock.mock.calls[0];
    expect(exitCode).toBe(0);
  });

  it('marks job done with -1 when process exits with null code', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    await startFixFromJob('src-job-1');
    (proc as any).emit('exit', null);
    await new Promise((r) => setImmediate(r));
    const [, exitCode] = markDoneMock.mock.calls[0];
    expect(exitCode).toBe(-1);
  });

  it('calls mkdirSync with recursive option before spawning', async () => {
    await startFixFromJob('src-job-1');
    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/logs', { recursive: true });
  });

  it('sets sessionId on the new job when source has a sessionId', async () => {
    getJobMock.mockReturnValue(makeSourceJob({ sessionId: 'ses-xyz' }));
    await startFixFromJob('src-job-1');
    const updatedJob = updateJobMock.mock.calls[0][0];
    expect(updatedJob.sessionId).toBe('ses-xyz');
  });
});
