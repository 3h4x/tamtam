import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startRelease — release pipeline entry decision tree', () => {
  let startRelease: typeof import('@/lib/start-release').startRelease;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let startProjectTestMock: ReturnType<typeof vi.fn>;
  let detectTestCommandMock: ReturnType<typeof vi.fn>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn();
    startProjectTestMock = vi.fn();
    detectTestCommandMock = vi.fn();
    startProjectReviewMock = vi.fn();
    startProjectPushMock = vi.fn();
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-rel-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
    updateJobMock = vi.fn();

    // Default exec mock: PM2 calls succeed; git calls must be set per-test via
    // mockImplementationOnce (they take priority over this default).
    execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'pm2' && args[0] === 'start') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (cmd === 'pm2' && args[0] === 'jlist') {
        return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/job-storage', () => ({
      listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
      createJob: createJobMock, updateJob: updateJobMock,
      getVerdict: vi.fn().mockReturnValue(null),
      markDone: vi.fn(),
    }));
    vi.doMock('@/lib/git-utils', () => ({
      isReviewed: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
    }));
    vi.doMock('@/lib/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
      releaseLock: vi.fn(),
    }));

    ({ startRelease } = await import('@/lib/start-release'));
  });

  afterEach(() => { vi.resetModules(); });

  function gitStatus(porcelain: string) {
    return Promise.resolve({ exitCode: 0, stdout: porcelain, stderr: '' });
  }
  function gitAhead(count: string) {
    return Promise.resolve({ exitCode: 0, stdout: count, stderr: '' });
  }

  it('returns 404 when project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const r = await startRelease('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('returns 409 when a pipeline job is already running for the project', async () => {
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'test', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('returns 409 when a fix-push pipeline job is already running (fix-push is a pipeline kind)', async () => {
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'fix-push', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('ignores non-pipeline running jobs (e.g. run, agent) when deciding conflict', async () => {
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'run', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // status --porcelain (hasChanges)
      .mockImplementationOnce(() => gitAhead('0'));           // rev-list --count
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });
    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
  });

  it('returns 400 when there are no changes and no unpushed commits', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))     // no changes
      .mockImplementationOnce(() => gitAhead('0'));    // no unpushed
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('Nothing to release');
    }
  });

  it('starts tests first when a test command is configured and there are changes', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // has tracked changes
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectTestMock.mockResolvedValue({ ok: true, jobId: 't1', pid: 1, logPath: '/tmp/t.log', testCmd: 'pnpm test' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.step).toBe('test');
      expect(r.jobId).toBe('t1');
      expect(r.message).toContain('pnpm test');
    }
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts review when there are changes and no test command is detected', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus('?? new.ts\n')) // untracked changes only — should still release
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectTestMock).not.toHaveBeenCalled();
  });

  it('pushes directly when there are no changes but unpushed commits exist', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))    // clean
      .mockImplementationOnce(() => gitAhead('2'));   // 2 unpushed
    startProjectPushMock.mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('propagates failure from startProjectTest', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectTestMock.mockResolvedValue({ ok: false, status: 409, detail: 'Tests already running for proj' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already running');
    }
  });

  it('propagates failure from startProjectReview', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 500, detail: 'review spawn failed' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });

  it('propagates failure from startProjectPush (push-only path)', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('1'));
    startProjectPushMock.mockResolvedValue({ ok: false, status: 502, detail: 'Push failed: remote rejected' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.detail).toContain('remote rejected');
    }
  });

  it('skips test+review and pushes directly when a fresh LGTM review exists', async () => {
    vi.resetModules();
    const latestReview = {
      id: 'prev-review', project: 'proj', kind: 'review',
      finishedAt: Date.now() / 1000 - 60, exitCode: 0,
    };
    const listJobsWithReview = vi.fn().mockReturnValue([latestReview]);
    const getVerdictLgtm = vi.fn().mockReturnValue('LGTM');
    const isReviewedTrue = vi.fn().mockResolvedValue(true);
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'deadbee', message: 'pushed' });
    detectTestCommandMock = vi.fn().mockReturnValue('pnpm test');
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // hasChanges
      .mockImplementationOnce(() => gitAhead('0'))            // unpushed
      // PM2 / jlist calls from createReleaseJob:
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/job-storage', () => ({
      listJobs: listJobsWithReview,
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      getVerdict: getVerdictLgtm,
    }));
    vi.doMock('@/lib/git-utils', () => ({ isReviewed: isReviewedTrue }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
    }));
    vi.doMock('@/lib/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/start-push', () => ({ startProjectPush: startProjectPushMock }));

    const { startRelease: fn } = await import('@/lib/start-release');
    const r = await fn('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push');
    expect(startProjectPushMock).toHaveBeenCalledWith('proj');
    expect(startProjectTestMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does NOT skip review when the working tree has changed since the LGTM (isReviewed=false)', async () => {
    vi.resetModules();
    const latestReview = {
      id: 'stale-review', project: 'proj', kind: 'review',
      finishedAt: Date.now() / 1000 - 60, exitCode: 0,
    };
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([latestReview]),
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      getVerdict: vi.fn().mockReturnValue('LGTM'),
    }));
    vi.doMock('@/lib/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
    }));
    vi.doMock('@/lib/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/start-push', () => ({ startProjectPush: startProjectPushMock }));

    const { startRelease: fn } = await import('@/lib/start-release');
    const r = await fn('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('creates a release meta-job and returns its id', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectTestMock.mockResolvedValue({ ok: true, jobId: 't1', pid: 1, logPath: '/tmp/t.log', testCmd: 'pnpm test' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.releaseJobId).toBe('proj-release-rel-id');
      expect(createJobMock).toHaveBeenCalledWith('proj', 'release', 0, '');
    }
  });

  it('does not create a release meta-job when there is nothing to release', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('0'));

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('treats git status exit failure as no tracked changes', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 128, stdout: '', stderr: 'not a repo' }))
      .mockImplementationOnce(() => gitAhead('0'));
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('pushes directly when no uncommitted changes exist even if a test command is configured', async () => {
    // changes=false, unpushed=1 — even with a test command, skip straight to push.
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(''))   // no uncommitted changes
      .mockImplementationOnce(() => gitAhead('1'));   // 1 unpushed commit
    startProjectPushMock.mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push');
    expect(startProjectTestMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('returns 409 with blockingJobId when pipeline lock cannot be acquired', async () => {
    vi.resetModules();
    detectTestCommandMock = vi.fn().mockReturnValue('pnpm test');
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // hasChanges
      .mockImplementationOnce(() => gitAhead('0'))            // unpushed
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
        if (cmd === 'pm2') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      getVerdict: vi.fn().mockReturnValue(null),
      markDone: vi.fn(),
    }));
    vi.doMock('@/lib/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
    }));
    vi.doMock('@/lib/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: false, lock: {}, blockingJobId: 'blocking-job-42' }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));

    const { startRelease: fn } = await import('@/lib/start-release');
    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already running');
      expect(r.blockingJobId).toBe('blocking-job-42');
    }
  });
});

describe('startRelease — abortRelease cleanup on step failure', () => {
  function makeJob(id: string, project: string) {
    return {
      id, project, kind: 'release', pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    };
  }

  async function setup(opts: {
    startProjectPushResult?: object;
    startProjectTestResult?: object;
    startProjectReviewResult?: object;
    detectTestCommandResult?: string | null;
    gitStatus?: string;
    gitAhead?: string;
  }) {
    vi.resetModules();

    const markDoneMock = vi.fn().mockResolvedValue(undefined);
    const releaseLockMock = vi.fn();
    const releaseJob = makeJob('release-job-1', 'proj');
    const createJobMock = vi.fn().mockReturnValue(releaseJob);
    const listJobsMock = vi.fn().mockReturnValue([releaseJob]);
    const execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status')) return Promise.resolve({ exitCode: 0, stdout: opts.gitStatus ?? ' M foo.ts\n', stderr: '' });
      if (cmd === 'git' && args.includes('rev-list')) return Promise.resolve({ exitCode: 0, stdout: opts.gitAhead ?? '0', stderr: '' });
      if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj') }));
    vi.doMock('@/lib/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: vi.fn().mockResolvedValue('finished'),
      createJob: createJobMock,
      updateJob: vi.fn(),
      getVerdict: vi.fn().mockReturnValue(null),
      markDone: markDoneMock,
    }));
    vi.doMock('@/lib/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
    }));
    vi.doMock('@/lib/start-test', () => ({
      startProjectTest: vi.fn().mockResolvedValue(opts.startProjectTestResult ?? { ok: true, jobId: 'test-1', testCmd: 'pnpm test' }),
      detectTestCommand: vi.fn().mockReturnValue(opts.detectTestCommandResult ?? null),
    }));
    vi.doMock('@/lib/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue(opts.startProjectReviewResult ?? { ok: true, jobId: 'review-1' }),
    }));
    vi.doMock('@/lib/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue(opts.startProjectPushResult ?? { ok: true, commitSha: 'abc', message: 'pushed' }),
    }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'release-job-1', acquiredAt: Date.now() / 1000 } }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
      releaseLock: releaseLockMock,
    }));

    const { startRelease: fn } = await import('@/lib/start-release');
    return { fn, markDoneMock, releaseLockMock };
  }

  afterEach(() => { vi.resetModules(); });

  it('calls markDone and releaseLock when startProjectPush fails on push-only path', async () => {
    const { fn, markDoneMock, releaseLockMock } = await setup({
      gitStatus: '',        // no uncommitted changes → push-only path
      gitAhead: '1',        // has unpushed commits
      startProjectPushResult: { ok: false, status: 502, detail: 'remote rejected' },
    });

    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
    expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'release-job-1' }), 1);
    expect(releaseLockMock).toHaveBeenCalledWith('proj', 'release-job-1');
  });

  it('calls markDone and releaseLock when startProjectTest fails', async () => {
    const { fn, markDoneMock, releaseLockMock } = await setup({
      detectTestCommandResult: 'pnpm test',
      startProjectTestResult: { ok: false, status: 409, detail: 'tests already running' },
    });

    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'release-job-1' }), 1);
    expect(releaseLockMock).toHaveBeenCalledWith('proj', 'release-job-1');
  });

  it('calls markDone and releaseLock when startProjectReview fails', async () => {
    const { fn, markDoneMock, releaseLockMock } = await setup({
      detectTestCommandResult: null,
      startProjectReviewResult: { ok: false, status: 500, detail: 'review spawn failed' },
    });

    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
    expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'release-job-1' }), 1);
    expect(releaseLockMock).toHaveBeenCalledWith('proj', 'release-job-1');
  });

  it('does NOT call releaseLock when step succeeds', async () => {
    const { fn, releaseLockMock } = await setup({
      detectTestCommandResult: null,
      startProjectReviewResult: { ok: true, jobId: 'review-1' },
    });

    const r = await fn('proj');
    expect(r.ok).toBe(true);
    expect(releaseLockMock).not.toHaveBeenCalled();
  });
});
