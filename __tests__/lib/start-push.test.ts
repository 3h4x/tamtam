import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startProjectPush — push result tracking', () => {
  let startProjectPush: typeof import('@/lib/start-push').startProjectPush;
  let execMock: ReturnType<typeof vi.fn>;
  let setProjectPushResultMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    setProjectPushResultMock = vi.fn();
    createJobMock = vi.fn().mockImplementation((project: string, kind: string, pid: number, logPath: string) => ({
      id: `${project}-${kind}-test-id`, project, kind, pid, logPath, prompt: null,
      startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    updateJobMock = vi.fn();

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/gh-status', () => ({ invalidateProject: vi.fn() }));
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
    }));

    ({ startProjectPush } = await import('@/lib/start-push'));
  });

  afterEach(() => { vi.resetModules(); });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  it('stores null error on successful push', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --name-status (hasStaged)
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))               // git diff --cached --stat (commit msg)
      .mockImplementationOnce(() => resp(0, 'diff --git a/foo.ts'))       // git diff --cached --no-color (commit msg)
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit --no-verify
      .mockImplementationOnce(() => resp(0))                              // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));                  // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('stores error string on commit failure', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git status --porcelain
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(1, '', 'pre-commit hook failed')); // git commit

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('Commit failed');
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Commit failed'));
  });

  it('stores error string on push failure', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached
      .mockImplementationOnce(() => resp(0, ''))                          // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, ''))                          // git status --porcelain (diff content)
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit
      .mockImplementationOnce(() => resp(1, '', 'remote rejected: permission denied')) // git push
      .mockImplementationOnce(() => resp(0, ''));                         // git status --porcelain (hook changes check → none)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('Push failed');
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Push failed'));
  });

  it('returns 404 when project path cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/gh-status', () => ({ invalidateProject: vi.fn() }));
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
    }));
    const { startProjectPush: fn } = await import('@/lib/start-push');
    const r = await fn('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('missing', expect.stringContaining('project not found'));
  });

  it('uses stdout as error detail when stderr is empty on commit failure', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git status --porcelain
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(1, 'CONFLICT: pre-commit rejected', '')); // git commit (stderr empty)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain('Commit failed');
      expect(r.detail).toContain('CONFLICT');
    }
  });

  it('falls back to generic message when both stderr and stdout are empty on commit failure', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git status --porcelain
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(2, '', ''));                     // git commit (both empty)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain('Commit failed');
      expect(r.detail).toContain('git commit exited 2');
    }
  });

  it('returns ok with "No changes to push" when nothing is staged and not ahead', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))         // git add -A
      .mockImplementationOnce(() => resp(0, ''))     // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '0'));   // git rev-list --count

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('No changes to push');
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('retries push with -u origin <branch> when "no upstream" error appears', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                                       // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))                        // git diff --cached
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))                        // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))                        // git diff --cached (content)
      .mockImplementationOnce(() => resp(0, 'chore: update'))                      // claude commit msg
      .mockImplementationOnce(() => resp(0))                                       // git commit
      .mockImplementationOnce(() => resp(1, '', 'error: The current branch has no upstream branch')) // git push (no upstream)
      .mockImplementationOnce(() => resp(0, 'feature-x'))                          // git branch --show-current
      .mockImplementationOnce(() => resp(0))                                       // git push -u origin feature-x
      .mockImplementationOnce(() => resp(0, 'abc1234'));                           // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    const upstreamPush = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('-u')
    );
    expect(upstreamPush).toBeTruthy();
  });

  it('reports push failure when upstream retry also fails', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                                        // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))                         // git diff --cached
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))                         // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))                         // git diff --cached (content)
      .mockImplementationOnce(() => resp(0, 'chore: update'))                       // claude commit msg
      .mockImplementationOnce(() => resp(0))                                        // git commit
      .mockImplementationOnce(() => resp(1, '', 'error: no upstream branch'))       // git push (no upstream)
      .mockImplementationOnce(() => resp(0, 'feature-x'))                           // git branch --show-current
      .mockImplementationOnce(() => resp(1, '', 'remote: permission denied'))       // git push -u (fails)
      .mockImplementationOnce(() => resp(0, ''));                                   // git status --porcelain (no hook changes)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.detail).toContain('Push failed');
    }
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Push failed'));
  });

  it('stages and commits hook-left changes then retries push when pre-push hook leaves new files', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --name-status (hasStaged)
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --stat (commit msg)
      .mockImplementationOnce(() => resp(0, 'diff --git a/foo.ts'))       // git diff --cached --no-color (commit msg)
      .mockImplementationOnce(() => resp(0, 'feat: add foo'))             // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit --no-verify
      .mockImplementationOnce(() => resp(1, '', 'pre-push hook: lint failed')) // git push (pre-push hook fails)
      .mockImplementationOnce(() => resp(0, 'M\t.lint-cache\n'))          // git status --porcelain (hook left changes)
      .mockImplementationOnce(() => resp(0))                              // git add -A (stage hook changes)
      .mockImplementationOnce(() => resp(0, 'A\t.lint-cache\n'))          // git diff --cached --stat (fix commit msg)
      .mockImplementationOnce(() => resp(0, 'diff --git a/.lint-cache'))  // git diff --cached --no-color (fix commit msg)
      .mockImplementationOnce(() => resp(0, 'chore: apply lint fixes'))   // claude fix commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit --no-verify (fix commit)
      .mockImplementationOnce(() => resp(0))                              // git push (retry — succeeds)
      .mockImplementationOnce(() => resp(0, 'def5678'));                  // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    // Verify the fix commit used --no-verify
    const fixCommit = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('commit') && args.includes('chore: apply lint fixes')
    );
    expect(fixCommit).toBeTruthy();
  });

  it('does not throw when setProjectPushResult throws', async () => {
    setProjectPushResultMock.mockImplementation(() => { throw new Error('DB locked'); });
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, ''))                          // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '0'));                        // git rev-list --count

    await expect(startProjectPush('proj')).resolves.not.toThrow();
  });

  it('creates a tracked "push" job and marks it done with exit 0 on success', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --name-status (hasStaged)
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))               // git diff --cached --stat (commit msg)
      .mockImplementationOnce(() => resp(0, 'diff --git a/foo.ts'))       // git diff --cached --no-color (commit msg)
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit --no-verify
      .mockImplementationOnce(() => resp(0))                              // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));                  // git rev-parse

    await startProjectPush('proj');
    expect(createJobMock).toHaveBeenCalledWith('proj', 'push', expect.any(Number), '');
    const job = createJobMock.mock.results[0].value;
    expect(job.logPath).toMatch(/\.log$/);
    expect(markDoneMock).toHaveBeenCalledWith(job, 0);
  });

  it('creates a tracked "push" job and marks it done with exit 1 on commit failure', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached (content)
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(1, '', 'pre-commit hook failed')); // git commit

    await startProjectPush('proj');
    expect(createJobMock).toHaveBeenCalled();
    const job = createJobMock.mock.results[0].value;
    expect(markDoneMock).toHaveBeenCalledWith(job, 1);
  });

  it('does not create a push job when project path cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/gh-status', () => ({ invalidateProject: vi.fn() }));
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
    }));
    const { startProjectPush: fn } = await import('@/lib/start-push');
    await fn('missing');
    expect(createJobMock).not.toHaveBeenCalled();
    expect(markDoneMock).not.toHaveBeenCalled();
  });
});
