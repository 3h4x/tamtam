import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startProjectReview', () => {
  let startProjectReview: typeof import('@/lib/pipeline/start-review').startProjectReview;
  let execMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let readLogMock: ReturnType<typeof vi.fn>;
  let readParsedLogMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let getLockMock: ReturnType<typeof vi.fn>;
  let acquireLockMock: ReturnType<typeof vi.fn>;
  let isLockOwnedByActiveReleaseMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;

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
    readLogMock = vi.fn().mockReturnValue('');
    readParsedLogMock = vi.fn().mockReturnValue('');
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    getLockMock = vi.fn().mockReturnValue(null);
    acquireLockMock = vi.fn().mockResolvedValue({ acquired: true });
    isLockOwnedByActiveReleaseMock = vi.fn().mockReturnValue(false);
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });

    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    }));

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      readLog: readLogMock,
      readParsedLog: readParsedLogMock,
      probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: 'Use LGTM / NEEDS ATTENTION / DO NOT SHIP.' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: getLockMock,
      acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/skills/skills', () => ({
      CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md',
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));

    ({ startProjectReview } = await import('@/lib/pipeline/start-review'));
  });

  afterEach(() => vi.resetModules());

  it('returns 400 when review_disabled is set for the project', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: () => ({ reviewDisabled: true }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]), readLog: readLogMock, readParsedLog: readParsedLogMock, probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: '' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: getLockMock, acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/skills/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md' }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() }));
    const { startProjectReview: fn } = await import('@/lib/pipeline/start-review');
    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('disabled');
    }
  });

  it('returns 404 when project path cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]), readLog: readLogMock, readParsedLog: readParsedLogMock, probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: '' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: getLockMock, acquireLock: acquireLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/skills/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/path' }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() }));

    const { startProjectReview: fn } = await import('@/lib/pipeline/start-review');
    const r = await fn('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('missing');
    }
  });

  it('returns 429 when every enabled provider is over budget', async () => {
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('passes through a preferred provider override when supplied', async () => {
    execMock.mockResolvedValueOnce(resp(0, ' M file.ts\n'));

    await startProjectReview('proj', { preferredProvider: 'codex' });

    expect(checkCliStartGateMock).toHaveBeenCalledWith('start a review', {
      parentJobId: null,
      preferred: 'codex',
      requestedModel: 'normal',
    });
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

  it('returns 400 when the worktree is clean and there are no unpushed commits', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '0\n'));

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No uncommitted changes or unpushed commits');
    }
  });

  it('reviews unpushed local commits when the worktree is clean', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ''))      // git status → clean
      .mockResolvedValueOnce(resp(0, '2\n'));  // git rev-list @{u}..HEAD → ahead

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    expect(startJobMock).toHaveBeenCalled();
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('working tree is clean');
    expect(prompt).toContain('2 local commits not yet pushed');
    expect(prompt).toContain('git diff @{u}..HEAD');
  });

  it('returns 400 when HEAD is exactly the reviewed ref (narrowCount=0) — no new commits to review', async () => {
    vi.resetModules();
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc1234';
    execMock = vi.fn()
      .mockResolvedValueOnce(resp(0, ''))          // git status → clean
      .mockResolvedValueOnce(resp(0, '2\n'))        // git rev-list @{u}..HEAD → ahead=2
      .mockResolvedValueOnce(resp(0, 'main\n'))     // git branch --show-current
      .mockResolvedValueOnce(resp(0, sha + '\n'))   // git rev-parse refs/tamtam/reviewed/main
      .mockResolvedValueOnce(resp(0, ''))            // git merge-base --is-ancestor → exit 0
      .mockResolvedValueOnce(resp(0, '0\n'));        // git rev-list --count <sha>..HEAD → 0

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: () => ({}),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]), readLog: vi.fn().mockReturnValue(''),
      readParsedLog: vi.fn().mockReturnValue(''), probeJobStatus: vi.fn().mockResolvedValue('done'),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: '', incremental_review_enabled: true }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/skills/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md' }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() }));

    const { startProjectReview: fn } = await import('@/lib/pipeline/start-review');
    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('already approved');
    }
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('narrows review scope to commits since last LGTM when incremental review is enabled', async () => {
    vi.resetModules();
    const sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    execMock = vi.fn()
      .mockResolvedValueOnce(resp(0, ''))          // git status → clean
      .mockResolvedValueOnce(resp(0, '3\n'))        // git rev-list @{u}..HEAD → ahead=3
      .mockResolvedValueOnce(resp(0, 'main\n'))     // git branch --show-current
      .mockResolvedValueOnce(resp(0, sha + '\n'))   // git rev-parse refs/tamtam/reviewed/main
      .mockResolvedValueOnce(resp(0, ''))            // git merge-base --is-ancestor → exit 0
      .mockResolvedValueOnce(resp(0, '1\n'));        // git rev-list --count <sha>..HEAD → 1 new

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: () => ({}),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]), readLog: vi.fn().mockReturnValue(''),
      readParsedLog: vi.fn().mockReturnValue(''), probeJobStatus: vi.fn().mockResolvedValue('done'),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: '', incremental_review_enabled: true }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getPipelineModel: () => 'sonnet',
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/skills/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md' }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() }));

    const { startProjectReview: fn } = await import('@/lib/pipeline/start-review');
    const r = await fn('proj');
    expect(r.ok).toBe(true);
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('already approved');
    expect(prompt).toContain('1 new commit');
    expect(prompt).toContain(sha.slice(0, 7));
    expect(prompt).not.toContain('@{u}..HEAD');
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

  it('requires structured findings with blast-radius review context', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));
    await startProjectReview('proj');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('Finding ID: stable-kebab-case-id');
    expect(prompt).toContain('Root cause:');
    expect(prompt).toContain('Affected paths:');
    expect(prompt).toContain('Documentation:');
    expect(prompt).toContain('Required tests:');
    expect(prompt).toContain('blast-radius checklist');
    expect(prompt).toContain('alternate routes or background jobs');
    expect(prompt).toContain('docs/*.md');
    expect(prompt).toContain('Do not require docs for trivial refactors');
  });

  it('tells reviewers the pipeline test step already validated the suite', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));
    await startProjectReview('proj');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('PIPELINE TEST CONTEXT');
    expect(prompt).toContain('The pipeline owns test execution');
    expect(prompt).toContain('Do not run tests, inspect test runner coverage, audit which package test commands are included');
    expect(prompt).toContain('Do not cite passing, failing, skipped, partial, or unexercised test suites as review findings');
    expect(prompt).toContain('Only mention tests when the code diff itself creates a concrete missing-coverage risk');
  });

  it('includes prior release review and fix context in follow-up reviews', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'release-1', kind: 'release', finishedAt: null, startedAt: 10 }),
      makeJob({ id: 'prev-review', kind: 'review', releaseId: 'release-1', finishedAt: 20, startedAt: 20, exitCode: 0 }),
      makeJob({ id: 'prev-fix', kind: 'fix', releaseId: 'release-1', finishedAt: 30, startedAt: 30, exitCode: 0 }),
    ]);
    readLogMock.mockImplementation((job: { id: string }) => {
      if (job.id === 'prev-review') {
        return '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Findings:\\n- Finding ID: shared-server-validation\\n  Root cause: server route bypass\\nVerdict: DO NOT SHIP"}}}';
      }
      if (job.id === 'prev-fix') {
        return '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Fix checklist:\\n- Finding ID: shared-server-validation\\n  Status: fixed"}}}';
      }
      return '';
    });
    readParsedLogMock.mockImplementation((job: { id: string }) => {
      if (job.id === 'prev-review') {
        return 'Findings:\n- Finding ID: shared-server-validation\n  Root cause: server route bypass\nVerdict: DO NOT SHIP\n';
      }
      return 'Fix checklist:\n- Finding ID: shared-server-validation\n  Status: fixed\n';
    });
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));

    await startProjectReview('proj');

    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('PREVIOUS RELEASE REVIEW/FIX CONTEXT');
    expect(prompt).toContain('prev-review');
    expect(prompt).toContain('shared-server-validation');
    expect(prompt).toContain('First verify whether earlier findings were actually fixed');
    expect(prompt).not.toContain('"type":"stream_event"');
    expect(readParsedLogMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'prev-review' }));
    expect(readParsedLogMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'prev-fix' }));
  });

  it('does not surface incidental id lines as findings in prior release context', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'release-2', kind: 'release', finishedAt: null, startedAt: 10 }),
      makeJob({ id: 'prev-review-2', kind: 'review', releaseId: 'release-2', finishedAt: 20, startedAt: 20, exitCode: 0 }),
      makeJob({ id: 'prev-fix-2', kind: 'fix', releaseId: 'release-2', finishedAt: 30, startedAt: 30, exitCode: 0 }),
    ]);
    readParsedLogMock.mockImplementation((job: { id: string }) => {
      if (job.id === 'prev-review-2') {
        return 'Findings:\n- Finding ID: shared-server-validation\n  Root cause: server route bypass\nVerdict: DO NOT SHIP\n';
      }
      return 'Fix checklist:\n- Root cause: updated cache flush path\n  id: shared-placeholder\n';
    });
    execMock.mockResolvedValueOnce(resp(0, 'M lib/foo.ts'));

    await startProjectReview('proj');

    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('prev-review-2');
    expect(prompt).toContain('shared-server-validation');
    expect(prompt).not.toContain(', findings shared-placeholder');
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
