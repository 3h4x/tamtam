import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startFixFromJob', () => {
  let startFixFromJob: typeof import('@/lib/pipeline/start-fix').startFixFromJob;
  let getJobMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let readParsedLogMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let acquireLockMock: ReturnType<typeof vi.fn>;
  let isLockOwnedByActiveReleaseMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;

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
    getJobMock = vi.fn().mockReturnValue(makeSourceJob());
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/myproject');
    readParsedLogMock = vi.fn().mockReturnValue('Error: test failure at line 42\n');
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      sessionId: null,
    }));
    updateJobMock = vi.fn();
    acquireLockMock = vi.fn().mockResolvedValue({ acquired: true });
    isLockOwnedByActiveReleaseMock = vi.fn().mockReturnValue(false);
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });
    startJobMock = vi.fn().mockResolvedValue(12345);

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      createJob: createJobMock,
      readParsedLog: readParsedLogMock,
      probeJobStatus: probeJobStatusMock,
      updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({
      startJobInProcess: startJobMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp/logs' }),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: () => ({ default_model: 'sonnet' }),
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));

    ({ startFixFromJob } = await import('@/lib/pipeline/start-fix'));
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

  it('returns 429 when every enabled provider is over budget', async () => {
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });
    const r = await startFixFromJob('src-job-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    expect(startJobMock).not.toHaveBeenCalled();
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
    readParsedLogMock.mockReturnValue('   ');
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

  it('starts fix jobs through the job runner', async () => {
    await startFixFromJob('src-job-1');
    expect(startJobMock).toHaveBeenCalledOnce();
    const [jobId, command] = startJobMock.mock.calls[0];
    expect(jobId).toBe('myproject-fix-id');
    expect(command).toMatch(/claude-shim\.js/);
    expect(command).toContain('--print');
    expect(command).toContain('--output-format stream-json');
  });

  it('uses log output as prompt when no sessionId', async () => {
    await startFixFromJob('src-job-1');
    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('Error: test failure at line 42');
    expect(prompt).toContain('myproject');
    expect(prompt).toContain('review');
  });

  it('uses parsed source output rather than raw stream-json in the fix prompt', async () => {
    readParsedLogMock.mockReturnValue('Findings:\n- Finding ID: canonical-url\n  Required fix: persist canonical URL\nVerdict: DO NOT SHIP\n');

    await startFixFromJob('src-job-1');

    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('Finding ID: canonical-url');
    expect(prompt).not.toContain('"type":"stream_event"');
    expect(prompt).not.toContain('[tamtam] launching');
    expect(prompt).not.toContain('Verdict: DO NOT SHIP');
  });

  it('embeds review findings in the prompt even when sessionId is present (resume)', async () => {
    getJobMock.mockReturnValue(makeSourceJob({ sessionId: 'ses-abc123' }));

    await startFixFromJob('src-job-1');

    const [, command, prompt] = startJobMock.mock.calls[0];
    expect(command).toContain('--resume ses-abc123');
    expect(prompt).toContain('Apply fixes for ALL the findings');
    expect(prompt).toContain('Error: test failure');
    expect(prompt).toContain('FIX METHOD');
    expect(prompt).toContain('Fix checklist');
  });

  it('records promptBytes and sessionId on the new job before persisting', async () => {
    getJobMock.mockReturnValue(makeSourceJob({ sessionId: 'ses-xyz' }));

    await startFixFromJob('src-job-1');

    const updatedJob = updateJobMock.mock.calls[0][0];
    expect(updatedJob.promptBytes).toBeGreaterThan(0);
    expect(updatedJob.sessionId).toBe('ses-xyz');
  });

  it('truncates log output exceeding 12000 chars', async () => {
    const longLog = 'x'.repeat(15000);
    readParsedLogMock.mockReturnValue(longLog);

    await startFixFromJob('src-job-1');

    const [, , prompt] = startJobMock.mock.calls[0];
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

  it('marks the job failed when PM2 startup throws', async () => {
    startJobMock.mockRejectedValue(new Error('spawn failed'));

    const r = await startFixFromJob('src-job-1');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Failed to start fix');
    }
    const failedJob = updateJobMock.mock.calls[0][0];
    expect(failedJob.exitCode).toBe(-1);
    expect(failedJob.finishedAt).toBeTypeOf('number');
  });

  it('returns 409 when jobs are globally paused', async () => {
    checkCliStartGateMock.mockResolvedValue({ ok: false, status: 409, detail: 'Jobs are paused globally.' });

    const r = await startFixFromJob('src-job-1');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('paused');
    }
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('appends fixPromptAddendum to the prompt when configured', async () => {
    vi.resetModules();
    startJobMock = vi.fn().mockResolvedValue(12345);
    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: vi.fn().mockReturnValue(makeSourceJob()),
      createJob: vi.fn().mockImplementation((project: string, kind: string) => ({
        id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
        prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false, sessionId: null,
      })),
      readParsedLog: vi.fn().mockReturnValue('Error: something broke\n'),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
      updateJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({ startJobInProcess: startJobMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/path') }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp/logs' }),
      getProjectPipelinePrompts: () => ({ fixPromptAddendum: 'Always run pnpm lint.', reviewPromptAddendum: null }),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: () => ({ default_model: 'sonnet' }),
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    }));

    const { startFixFromJob: fn } = await import('@/lib/pipeline/start-fix');
    await fn('src-job-1');

    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('Project-specific fix guidance');
    expect(prompt).toContain('Always run pnpm lint.');
  });
});
