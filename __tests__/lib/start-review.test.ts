import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startProjectReview', () => {
  let startProjectReview: typeof import('@/lib/start-review').startProjectReview;
  let execMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let getLockMock: ReturnType<typeof vi.fn>;
  let acquireLockMock: ReturnType<typeof vi.fn>;
  let isLockOwnedByActiveReleaseMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function makeJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'review-job-1', project: 'proj', kind: 'review', pid: 0, logPath: null,
      prompt: null, startedAt: Date.now() / 1000, finishedAt: null, exitCode: null, seen: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(9999);
    updateJobMock = vi.fn();
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    getLockMock = vi.fn().mockReturnValue(null);
    acquireLockMock = vi.fn().mockResolvedValue({ acquired: true });
    isLockOwnedByActiveReleaseMock = vi.fn().mockReturnValue(false);

    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    }));

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/config', () => ({
      getSettings: () => ({ review_verdict_rules: 'Use LGTM / NEEDS ATTENTION / DO NOT SHIP.' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      getLock: getLockMock,
      acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/skills', () => ({
      CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md',
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));

    ({ startProjectReview } = await import('@/lib/start-review'));
  });

  afterEach(() => vi.resetModules());

  it('returns 400 when review_disabled is set for the project', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: () => ({ reviewDisabled: true }),
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]), probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/config', () => ({
      getSettings: () => ({ review_verdict_rules: '' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      getLock: getLockMock, acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md' }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() }));
    const { startProjectReview: fn } = await import('@/lib/start-review');
    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('disabled');
    }
  });

  it('returns 404 when project path cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]), probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/config', () => ({
      getSettings: () => ({ review_verdict_rules: '' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      getLock: getLockMock, acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/path' }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() }));

    const { startProjectReview: fn } = await import('@/lib/start-review');
    const r = await fn('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('missing');
    }
  });

  it('returns 409 when pipeline lock is held by another job', async () => {
    getLockMock.mockReturnValue({ lockedByJobId: 'other-job' });
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.blockingJobId).toBe('other-job');
    }
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('bypasses lock check when under an active release', async () => {
    getLockMock.mockReturnValue({ lockedByJobId: 'release-job' });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    // no uncommitted changes
    execMock.mockResolvedValueOnce(resp(0, ''));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400); // no changes, not a 409
  });

  it('returns 409 when a review is already running for the project', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already in progress');
    }
  });

  it('does not return 409 when the "running" review job has actually exited', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('done');
    execMock.mockResolvedValueOnce(resp(0, '')); // git status → no changes
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400); // proceeds past running check, hits no-changes
  });

  it('returns 400 when there are no uncommitted changes', async () => {
    execMock.mockResolvedValueOnce(resp(0, '')); // git status --porcelain → empty
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No uncommitted changes');
    }
  });

  it('returns ok with jobId and pid when review starts successfully', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts')); // git status → has changes
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBe('proj-review-id');
      expect(r.pid).toBe(9999);
      expect(r.logPath).toMatch(/\.log$/);
    }
    expect(createJobMock).toHaveBeenCalledWith('proj', 'review', 0, '');
    expect(startJobMock).toHaveBeenCalled();
  });

  it('persists job failure when startJob throws', async () => {
    startJobMock.mockRejectedValueOnce(new Error('spawn failed'));
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Failed to start review');
    }
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('acquires pipeline lock after successful job start when not under release', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));
    await startProjectReview('proj');
    expect(acquireLockMock).toHaveBeenCalledWith('proj', 'proj-review-id');
  });

  it('does not acquire pipeline lock when running under active release', async () => {
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));
    await startProjectReview('proj');
    expect(acquireLockMock).not.toHaveBeenCalled();
  });

  it('passes project name and path into the prompt', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));
    await startProjectReview('proj');
    // startJob(jobId, command, prompt, cwd) → prompt is at index 2
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('proj');
    expect(prompt).toContain('/path/to/proj');
  });

  it('injects review_verdict_rules into the prompt', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));
    await startProjectReview('proj');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('Use LGTM / NEEDS ATTENTION / DO NOT SHIP.');
  });

  it('only checks running jobs of kind "review" (ignores other kinds)', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'fix', finishedAt: null }),
      makeJob({ kind: 'test', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    execMock.mockResolvedValueOnce(resp(0, '')); // no changes
    const r = await startProjectReview('proj');
    // Should not hit the 409 — only review jobs are checked
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});
