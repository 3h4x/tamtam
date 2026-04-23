import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startPrReview', () => {
  let startPrReview: typeof import('@/lib/start-pr-review').startPrReview;
  let execMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;

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
    }));
    vi.doMock('@/lib/skills', () => ({
      CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md',
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }));

    ({ startPrReview } = await import('@/lib/start-pr-review'));
  });

  afterEach(() => vi.resetModules());

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
    }));
    vi.doMock('@/lib/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/path' }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn() }));

    const { startPrReview: fn } = await import('@/lib/start-pr-review');
    const r = await fn('missing', 42, 'Fix bug', 'fix/42', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('missing');
    }
  });

  it('returns 409 when a review is already running for the project', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already in progress');
    }
  });

  it('does not return 409 when the "running" review has actually exited', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('done');
    // diff returns empty — gets a 400 from no-diff check
    execMock.mockResolvedValueOnce(resp(0, ''));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when gh pr diff returns empty output', async () => {
    execMock.mockResolvedValueOnce(resp(0, '   \n'));
    const r = await startPrReview('proj', 7, 'Some PR', 'fix/7', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No diff found for PR #7');
    }
  });

  it('returns ok with jobId and pid when PR review starts successfully', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts\n+added'));
    const r = await startPrReview('proj', 42, 'Fix everything', 'fix/42', 'main');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBe('proj-review-id');
      expect(r.pid).toBe(9999);
      expect(r.logPath).toMatch(/\.log$/);
    }
    expect(createJobMock).toHaveBeenCalledWith('proj', 'review', 0, '');
    expect(startJobMock).toHaveBeenCalled();
  });

  it('creates a review job with kind "review"', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(createJobMock).toHaveBeenCalledWith('proj', 'review', 0, '');
  });

  it('persists job failure when startJob throws', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    startJobMock.mockRejectedValueOnce(new Error('spawn failed'));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Failed to start PR review');
    }
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('substitutes PR metadata into the prompt', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/file.ts b/file.ts'));
    await startPrReview('proj', 99, 'My PR Title', 'feature/my-branch', 'develop');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('proj');
    expect(prompt).toContain('/path/to/proj');
    expect(prompt).toContain('99');
    expect(prompt).toContain('My PR Title');
    expect(prompt).toContain('feature/my-branch');
    expect(prompt).toContain('develop');
  });

  it('injects the diff into the prompt', async () => {
    const diffText = 'diff --git a/foo.ts b/foo.ts\n+new line';
    execMock.mockResolvedValueOnce(resp(0, diffText));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain(diffText);
  });

  it('injects review_verdict_rules into the prompt', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('Use LGTM / NEEDS ATTENTION / DO NOT SHIP.');
  });

  it('only checks review-kind running jobs (ignores fix/test)', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'fix', finishedAt: null }),
      makeJob({ kind: 'test', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    execMock.mockResolvedValueOnce(resp(0, ''));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    // Should not return 409 — only review-kind jobs are checked
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('invokes gh pr diff with the correct PR number', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 123, 'Title', 'feat/123', 'main');
    expect(execMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'diff', '123'],
      expect.objectContaining({ cwd: '/path/to/proj' })
    );
  });

  it('updates the job with logPath and pid after successful start', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.pid).toBe(9999);
    expect(savedJob.logPath).toMatch(/\.log$/);
  });
});
