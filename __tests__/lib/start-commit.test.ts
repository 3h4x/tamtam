import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Pure helpers — no mocks needed
// ---------------------------------------------------------------------------

describe('issueBranchName', () => {
  it('produces a valid branch name from a normal issue title', async () => {
    const { issueBranchName } = await import('@/lib/start-commit');
    expect(issueBranchName({ number: 42, title: 'Add dark mode toggle' }))
      .toBe('fix/issue-42-add-dark-mode-toggle');
  });

  it('strips leading/trailing hyphens from slugified title', async () => {
    const { issueBranchName } = await import('@/lib/start-commit');
    expect(issueBranchName({ number: 1, title: '!!!Special chars!!!' }))
      .toBe('fix/issue-1-special-chars');
  });

  it('truncates long titles to 40 chars without trailing hyphens', async () => {
    const { issueBranchName } = await import('@/lib/start-commit');
    const branch = issueBranchName({ number: 7, title: 'A'.repeat(50) });
    const slug = branch.replace('fix/issue-7-', '');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
  });

  it('handles empty title gracefully', async () => {
    const { issueBranchName } = await import('@/lib/start-commit');
    expect(issueBranchName({ number: 5, title: '' })).toBe('fix/issue-5');
  });

  it('lowercases the title slug', async () => {
    const { issueBranchName } = await import('@/lib/start-commit');
    expect(issueBranchName({ number: 3, title: 'FIX: Memory Leak In Parser' }))
      .toBe('fix/issue-3-fix-memory-leak-in-parser');
  });
});

// ---------------------------------------------------------------------------
// detectMainBranch
// ---------------------------------------------------------------------------

describe('detectMainBranch', () => {
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
  });
  afterEach(() => vi.resetModules());

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  it('returns branch from symbolic-ref when it succeeds', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'));
    const { detectMainBranch } = await import('@/lib/start-commit');
    expect(await detectMainBranch('/repo')).toBe('main');
  });

  it('returns "master" branch from symbolic-ref', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'refs/remotes/origin/master\n'));
    const { detectMainBranch } = await import('@/lib/start-commit');
    expect(await detectMainBranch('/repo')).toBe('master');
  });

  it('falls back to "main" when symbolic-ref fails but main exists', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, ''))         // git symbolic-ref fails
      .mockResolvedValueOnce(resp(0, 'abc1234')); // git rev-parse main succeeds
    const { detectMainBranch } = await import('@/lib/start-commit');
    expect(await detectMainBranch('/repo')).toBe('main');
  });

  it('falls back to "master" when both symbolic-ref and main rev-parse fail', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, ''))  // git symbolic-ref fails
      .mockResolvedValueOnce(resp(1, '')); // git rev-parse main fails → master
    const { detectMainBranch } = await import('@/lib/start-commit');
    expect(await detectMainBranch('/repo')).toBe('master');
  });
});

// ---------------------------------------------------------------------------
// findIssueContext
// ---------------------------------------------------------------------------

describe('findIssueContext', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;

  function makeJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'j1', project: 'p', kind: 'run', prompt: null, pid: 1,
      logPath: null, startedAt: Date.now() / 1000, finishedAt: null,
      exitCode: null, seen: false, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0,
      ghIssueNumber: null, ghIssueRepo: null, ghIssueTitle: null,
      ...overrides,
    };
  }

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(() => {
    vi.resetModules();
    execMock = vi.fn();
    listJobsMock = vi.fn().mockReturnValue([]);
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/job-storage', () => ({ listJobs: listJobsMock }));
  });
  afterEach(() => vi.resetModules());

  it('returns null when no run jobs with issue numbers exist', async () => {
    listJobsMock.mockReturnValue([makeJob()]);
    const { findIssueContext } = await import('@/lib/start-commit');
    expect(await findIssueContext('p', '/repo')).toBeNull();
  });

  it('returns issue context when latest run job has an issue number and issue is open', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ ghIssueNumber: 10, ghIssueRepo: 'org/repo', ghIssueTitle: 'Fix bug', startedAt: 1000 }),
    ]);
    execMock.mockResolvedValueOnce(resp(0, JSON.stringify({ state: 'OPEN' })));
    const { findIssueContext } = await import('@/lib/start-commit');
    const ctx = await findIssueContext('p', '/repo');
    expect(ctx).toEqual({ number: 10, repo: 'org/repo', title: 'Fix bug' });
  });

  it('returns null when issue is closed', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ ghIssueNumber: 10, ghIssueRepo: 'org/repo', ghIssueTitle: 'Fix bug' }),
    ]);
    execMock.mockResolvedValueOnce(resp(0, JSON.stringify({ state: 'CLOSED' })));
    const { findIssueContext } = await import('@/lib/start-commit');
    expect(await findIssueContext('p', '/repo')).toBeNull();
  });

  it('uses issue context optimistically when gh is unreachable', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ ghIssueNumber: 5, ghIssueRepo: 'org/repo', ghIssueTitle: 'Crash fix' }),
    ]);
    execMock.mockRejectedValueOnce(new Error('ENOENT: gh not found'));
    const { findIssueContext } = await import('@/lib/start-commit');
    const ctx = await findIssueContext('p', '/repo');
    expect(ctx).toEqual({ number: 5, repo: 'org/repo', title: 'Crash fix' });
  });

  it('skips gh check when repo is empty and returns context directly', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ ghIssueNumber: 3, ghIssueRepo: '', ghIssueTitle: 'Perf fix' }),
    ]);
    const { findIssueContext } = await import('@/lib/start-commit');
    const ctx = await findIssueContext('p', '/repo');
    expect(ctx).toEqual({ number: 3, repo: '', title: 'Perf fix' });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('picks the most recent job (highest startedAt) when multiple jobs match', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ ghIssueNumber: 1, ghIssueRepo: 'org/repo', ghIssueTitle: 'Old', startedAt: 500 }),
      makeJob({ ghIssueNumber: 2, ghIssueRepo: 'org/repo', ghIssueTitle: 'New', startedAt: 1000 }),
    ]);
    execMock.mockResolvedValue(resp(0, JSON.stringify({ state: 'OPEN' })));
    const { findIssueContext } = await import('@/lib/start-commit');
    const ctx = await findIssueContext('p', '/repo');
    expect(ctx?.number).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// generateCommitMessage
// ---------------------------------------------------------------------------

describe('generateCommitMessage', () => {
  let execMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(() => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({ getSettings: () => ({ commit_style: '' }) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/diff-context', () => ({
      buildDiffContext: vi.fn().mockReturnValue({ context: 'diff context here', truncated: false }),
    }));
  });
  afterEach(() => vi.resetModules());

  it('returns a valid conventional-commit title from claude output', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'lib/foo.ts | 5 ++++'))   // git diff --cached --stat
      .mockResolvedValueOnce(resp(0, '+const x = 1'))           // git diff --cached
      .mockResolvedValueOnce(resp(0, 'feat: add dark mode\n')); // claude
    const { generateCommitMessage } = await import('@/lib/start-commit');
    expect(await generateCommitMessage('/repo', 'myproject')).toBe('feat: add dark mode');
  });

  it('strips markdown formatting artifacts from claude output', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'lib/foo.ts | 2 ++'))
      .mockResolvedValueOnce(resp(0, '+x'))
      .mockResolvedValueOnce(resp(0, '**fix: resolve null pointer**\n'));
    const { generateCommitMessage } = await import('@/lib/start-commit');
    expect(await generateCommitMessage('/repo', 'p')).toBe('fix: resolve null pointer');
  });

  it('retries when first attempt returns a generic message', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'lib/foo.ts | 2 ++'))  // stat
      .mockResolvedValueOnce(resp(0, '+x'))                  // diff
      .mockResolvedValueOnce(resp(0, 'chore: automated update\n'))  // claude attempt 1 (generic)
      .mockResolvedValueOnce(resp(0, 'refactor: extract helper function\n')); // claude attempt 2 (specific)
    const { generateCommitMessage } = await import('@/lib/start-commit');
    expect(await generateCommitMessage('/repo', 'p')).toBe('refactor: extract helper function');
  });

  it('falls back to stat-derived message when both claude attempts are generic', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'lib/auth.ts | 3 +++\nlib/config.ts | 1 +\n'))  // stat
      .mockResolvedValueOnce(resp(0, '+x'))                                            // diff
      .mockResolvedValueOnce(resp(0, 'chore: automated update\n'))  // attempt 1 generic
      .mockResolvedValueOnce(resp(0, 'chore: update\n'));            // attempt 2 generic
    const { generateCommitMessage } = await import('@/lib/start-commit');
    const msg = await generateCommitMessage('/repo', 'p');
    expect(msg).toMatch(/^chore: update lib\/auth\.ts/);
  });

  it('returns fallback "chore: update files" when stat has no file entries and claude returns empty output', async () => {
    // Both claude calls return empty output → msg1 = '' (falsy) → stat fallback → no filenames → 'chore: update files'
    execMock
      .mockResolvedValueOnce(resp(0, ''))   // git diff --cached --stat (empty)
      .mockResolvedValueOnce(resp(0, ''))   // git diff --cached (empty)
      .mockResolvedValueOnce(resp(0, ''))   // claude attempt 1 → empty → msg1 = ''
      .mockResolvedValueOnce(resp(0, ''));  // claude attempt 2 → empty → msg2 = ''
    const { generateCommitMessage } = await import('@/lib/start-commit');
    expect(await generateCommitMessage('/repo', 'p')).toBe('chore: update files');
  });

  it('includes commit style guide in prompt when configured', async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({ getSettings: () => ({ commit_style: 'Use imperative mood' }) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/diff-context', () => ({
      buildDiffContext: vi.fn().mockReturnValue({ context: 'diff context here', truncated: false }),
    }));
    const calls: string[][] = [];
    execMock.mockImplementation((_bin: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--stat')) return resp(0, 'lib/foo.ts | 1 +');
      if (args[0] === '-C') return resp(0, '+x');
      return resp(0, 'feat: add something');
    });
    const { generateCommitMessage } = await import('@/lib/start-commit');
    await generateCommitMessage('/repo', 'p');
    const claudeCall = calls.find(a => a.includes('-p'));
    const prompt = claudeCall?.find(a => a.includes('Use imperative mood'));
    expect(prompt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// startProjectCommit — integration (entry point)
// ---------------------------------------------------------------------------

describe('startProjectCommit', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let setProjectPushResultMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function setupMocks(overrides: {
    resolvePath?: string | null;
    lockHeld?: boolean;
    underRelease?: boolean;
  } = {}) {
    const {
      resolvePath = '/path/to/proj',
      lockHeld = false,
      underRelease = false,
    } = overrides;

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(resolvePath),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({ getSettings: () => ({ commit_style: '' }) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      setProjectPushResult: setProjectPushResultMock,
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      markDone: markDoneMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
    }));
    vi.doMock('@/lib/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(lockHeld ? { lockedByJobId: 'blocker-job' } : null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(underRelease),
    }));
    vi.doMock('@/lib/diff-context', () => ({
      buildDiffContext: vi.fn().mockReturnValue({ context: '', truncated: false }),
    }));
  }

  beforeEach(() => {
    vi.resetModules();
    execMock = vi.fn();
    setProjectPushResultMock = vi.fn();
    listJobsMock = vi.fn().mockReturnValue([]);
    createJobMock = vi.fn().mockImplementation((project: string, kind: string, pid: number, logPath: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid, logPath, prompt: null,
      startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null, ghIssueNumber: null,
      ghIssueRepo: null, ghIssueTitle: null,
    }));
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    updateJobMock = vi.fn();
  });
  afterEach(() => vi.resetModules());

  it('returns 404 when project path cannot be resolved', async () => {
    setupMocks({ resolvePath: null });
    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('missing', 'project not found');
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 with blockingJobId when pipeline lock is held', async () => {
    setupMocks({ lockHeld: true });
    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.blockingJobId).toBe('blocker-job');
    }
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('skips lock check when running under an active release', async () => {
    setupMocks({ underRelease: true, lockHeld: true });
    // Nothing to commit path
    execMock.mockResolvedValue(resp(0, '')); // git diff --cached --stat + diff + status
    execMock
      .mockResolvedValueOnce(resp(0, ''))     // git diff --cached --stat (for generateCommitMessage)
      .mockResolvedValueOnce(resp(0, ''))     // git diff --cached
      .mockResolvedValueOnce(resp(0, ''))     // git add -A
      .mockResolvedValueOnce(resp(0, ''))     // git diff --cached --name-status (empty → nothing to stage)
      .mockResolvedValueOnce(resp(0, '0\n'))  // git rev-list --count
      ;
    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    // Under release the lock check is bypassed — result depends on git state, not lock
    expect(createJobMock).toHaveBeenCalled();
  });

  it('creates a commit job and marks it done with exit 0 on success', async () => {
    setupMocks();
    execMock
      .mockResolvedValueOnce(resp(0, ''))          // findIssueContext: listJobs → no issue
      .mockResolvedValueOnce(resp(0, 'M\tlib/foo.ts\n'))  // git add -A (triggers diff --cached --name-status)
    ;
    // Re-mock so execMock calls go in order for the full commit path
    vi.resetModules();
    setupMocks();
    execMock
      .mockResolvedValueOnce(resp(0, 'lib/foo.ts | 3 +++'))  // git diff --cached --stat (generateCommitMessage)
      .mockResolvedValueOnce(resp(0, '+const x'))              // git diff --cached
      .mockResolvedValueOnce(resp(0, 'feat: add feature'))    // claude
      .mockResolvedValueOnce(resp(0))                          // git add -A
      .mockResolvedValueOnce(resp(0, 'M\tlib/foo.ts'))        // git diff --cached --name-status (has staged)
      .mockResolvedValueOnce(resp(0, 'abc1234'))               // git commit
      .mockResolvedValueOnce(resp(0, 'abc1234'))               // git rev-parse HEAD
    ;
    // We also need to mock listJobs for findIssueContext (called in startProjectCommit)
    listJobsMock.mockReturnValue([]);

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(createJobMock).toHaveBeenCalled();
    const job = createJobMock.mock.results[0].value;
    expect(markDoneMock).toHaveBeenCalledWith(job, 0);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('returns ok "Nothing to commit" when nothing is staged and not ahead', async () => {
    setupMocks();
    listJobsMock.mockReturnValue([]);
    // findIssueContext: no exec calls (listJobs returns [])
    // runCommit path (no issueCtx): git add -A → git diff --cached --name-status (empty) → git rev-list (0)
    execMock
      .mockResolvedValueOnce(resp(0))        // git add -A
      .mockResolvedValueOnce(resp(0, ''))    // git diff --cached --name-status → empty (nothing staged)
      .mockResolvedValueOnce(resp(0, '0\n')) // git rev-list --count @{u}..HEAD
    ;

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toContain('Nothing to commit');
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('marks job done with exit 1 when git commit fails', async () => {
    setupMocks();
    listJobsMock.mockReturnValue([]);
    execMock
      .mockResolvedValueOnce(resp(0, 'lib/foo.ts | 2 ++'))   // stat (generateCommitMessage)
      .mockResolvedValueOnce(resp(0, '+x'))                    // diff
      .mockResolvedValueOnce(resp(0, 'fix: resolve issue'))   // claude
      .mockResolvedValueOnce(resp(0))                          // git add -A
      .mockResolvedValueOnce(resp(0, 'M\tfile.ts'))           // git diff --cached --name-status (has staged)
      .mockResolvedValueOnce(resp(1, '', 'pre-commit hook rejected')) // git commit fails
      .mockResolvedValueOnce(resp(0, ''))                      // git status --porcelain (no hook changes)
    ;

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Commit failed');
    }
    const job = createJobMock.mock.results[0].value;
    expect(markDoneMock).toHaveBeenCalledWith(job, 1);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Commit failed'));
  });

  it('stages hook changes and retries commit when pre-commit hook modifies files', async () => {
    setupMocks();
    listJobsMock.mockReturnValue([]);
    execMock
      .mockResolvedValueOnce(resp(0, 'lib/foo.ts | 1 +'))   // stat
      .mockResolvedValueOnce(resp(0, '+x'))                   // diff
      .mockResolvedValueOnce(resp(0, 'chore: lint'))         // claude
      .mockResolvedValueOnce(resp(0))                         // git add -A
      .mockResolvedValueOnce(resp(0, 'M\tfile.ts'))          // git diff --cached --name-status
      .mockResolvedValueOnce(resp(1, '', 'hook modified files'))  // git commit (first attempt fails)
      .mockResolvedValueOnce(resp(0, 'M\t.lint'))            // git status --porcelain (hook left changes)
      .mockResolvedValueOnce(resp(0))                         // git add -A (stage hook changes)
      .mockResolvedValueOnce(resp(0, 'ok'))                  // git commit (retry succeeds)
      .mockResolvedValueOnce(resp(0, 'def5678'))             // git rev-parse
    ;

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(true);
    // Verify two separate git commit calls were made
    const commitCalls = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && Array.isArray(args) && args.includes('commit')
    );
    expect(commitCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('switches to feature branch before commit when on default branch with issue context', async () => {
    setupMocks();
    listJobsMock.mockReturnValue([{
      id: 'j1', project: 'proj', kind: 'run', ghIssueNumber: 7,
      ghIssueRepo: '', ghIssueTitle: 'Add feature', startedAt: 1000,
    }]);
    // runCommit exec order with issueCtx on main branch:
    // 1. git branch --show-current → 'main'
    // 2. detectMainBranch: git symbolic-ref → 'refs/remotes/origin/main'
    // 3. git checkout -b fix/issue-7-add-feature
    // 4. git add -A
    // 5. git diff --cached --name-status → staged files
    // 6. generateCommitMessage: git diff --cached --stat
    // 7. generateCommitMessage: git diff --cached
    // 8. generateCommitMessage: claude
    // 9. git commit -m <msg>
    // 10. git rev-parse --short HEAD
    execMock
      .mockResolvedValueOnce(resp(0, 'main\n'))                       // git branch --show-current → on main
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))  // detectMainBranch (symbolic-ref)
      .mockResolvedValueOnce(resp(0))                                  // git checkout -b fix/issue-7-add-feature
      .mockResolvedValueOnce(resp(0))                                  // git add -A
      .mockResolvedValueOnce(resp(0, 'M\tlib/x.ts'))                 // git diff --cached --name-status → staged
      .mockResolvedValueOnce(resp(0, 'lib/x.ts | 1 +'))              // generateCommitMessage: stat
      .mockResolvedValueOnce(resp(0, '+x'))                           // generateCommitMessage: diff
      .mockResolvedValueOnce(resp(0, 'feat: add feature'))           // generateCommitMessage: claude
      .mockResolvedValueOnce(resp(0, 'ok'))                           // git commit
      .mockResolvedValueOnce(resp(0, 'abc'))                          // git rev-parse
    ;

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(true);
    const checkoutCall = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && Array.isArray(args) && args.includes('checkout') && args.includes('-b')
    );
    expect(checkoutCall).toBeTruthy();
  });

  it('checks out existing branch when checkout -b fails (branch already exists)', async () => {
    setupMocks();
    listJobsMock.mockReturnValue([{
      id: 'j1', project: 'proj', kind: 'run', ghIssueNumber: 8,
      ghIssueRepo: '', ghIssueTitle: 'Existing feature', startedAt: 1000,
    }]);
    // On main branch → tries checkout -b → fails (already exists) → checkout existing succeeds
    execMock
      .mockResolvedValueOnce(resp(0, 'main\n'))                        // git branch --show-current
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))   // detectMainBranch
      .mockResolvedValueOnce(resp(1, '', 'already exists'))            // git checkout -b → fails
      .mockResolvedValueOnce(resp(0))                                   // git checkout existing → succeeds
      .mockResolvedValueOnce(resp(0))                                   // git add -A
      .mockResolvedValueOnce(resp(0, 'M\tlib/x.ts'))                  // git diff --cached --name-status
      .mockResolvedValueOnce(resp(0, 'lib/x.ts | 1 +'))               // generateCommitMessage: stat
      .mockResolvedValueOnce(resp(0, '+x'))                            // generateCommitMessage: diff
      .mockResolvedValueOnce(resp(0, 'feat: existing feature'))        // generateCommitMessage: claude
      .mockResolvedValueOnce(resp(0, 'ok'))                            // git commit
      .mockResolvedValueOnce(resp(0, 'abc'))                           // git rev-parse
    ;

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(true);
    // Both checkout calls were made
    const checkoutCalls = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && Array.isArray(args) && args.includes('checkout')
    );
    expect(checkoutCalls.length).toBe(2);
    // Second checkout was without -b (existing branch)
    const existingCheckout = checkoutCalls[1];
    expect(existingCheckout[1]).not.toContain('-b');
  });

  it('returns 500 when both checkout -b and checkout existing fail', async () => {
    setupMocks();
    listJobsMock.mockReturnValue([{
      id: 'j1', project: 'proj', kind: 'run', ghIssueNumber: 9,
      ghIssueRepo: '', ghIssueTitle: 'Broken branch', startedAt: 1000,
    }]);
    execMock
      .mockResolvedValueOnce(resp(0, 'main\n'))                        // git branch --show-current
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))   // detectMainBranch
      .mockResolvedValueOnce(resp(1, '', 'checkout -b failed'))        // git checkout -b → fails
      .mockResolvedValueOnce(resp(1, '', 'checkout also failed'))      // git checkout existing → also fails
    ;

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Failed to create issue branch');
    }
    const job = createJobMock.mock.results[0].value;
    expect(markDoneMock).toHaveBeenCalledWith(job, 1);
  });

  it('does not switch branch when already on a feature branch', async () => {
    setupMocks();
    listJobsMock.mockReturnValue([{
      id: 'j1', project: 'proj', kind: 'run', ghIssueNumber: 7,
      ghIssueRepo: '', ghIssueTitle: 'Add feature', startedAt: 1000,
    }]);
    // runCommit exec order with issueCtx already on feature branch:
    // 1. git branch --show-current → 'fix/issue-7-add-feature' (not main → skip checkout)
    // 2. detectMainBranch: git symbolic-ref → 'refs/remotes/origin/main'
    // 3. git add -A
    // 4. git diff --cached --name-status → staged
    // 5-7. generateCommitMessage (stat, diff, claude)
    // 8. git commit
    // 9. git rev-parse
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-7-add-feature\n'))  // git branch --show-current
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))  // detectMainBranch
      .mockResolvedValueOnce(resp(0))                                  // git add -A
      .mockResolvedValueOnce(resp(0, 'M\tlib/x.ts'))                 // git diff --cached --name-status
      .mockResolvedValueOnce(resp(0, 'lib/x.ts | 1 +'))              // generateCommitMessage: stat
      .mockResolvedValueOnce(resp(0, '+x'))                           // generateCommitMessage: diff
      .mockResolvedValueOnce(resp(0, 'feat: something'))             // generateCommitMessage: claude
      .mockResolvedValueOnce(resp(0, 'ok'))                           // git commit
      .mockResolvedValueOnce(resp(0, 'abc'))                          // git rev-parse
    ;

    const { startProjectCommit } = await import('@/lib/start-commit');
    const r = await startProjectCommit('proj');
    expect(r.ok).toBe(true);
    const checkoutBCalls = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && Array.isArray(args) && args.includes('checkout') && args.includes('-b')
    );
    expect(checkoutBCalls.length).toBe(0);
  });
});
