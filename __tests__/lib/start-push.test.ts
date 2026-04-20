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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(1, '', 'pre-commit hook failed')) // git commit
      .mockImplementationOnce(() => resp(0, ''));                          // git status --porcelain (no hook changes)

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
      .mockImplementationOnce(() => resp(0, ''))                          // git diff --cached --no-color (diff content)
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(1, 'CONFLICT: pre-commit rejected', '')) // git commit (stderr empty)
      .mockImplementationOnce(() => resp(0, ''));                                   // git status --porcelain (no hook changes)

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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(2, '', ''))                      // git commit (both empty)
      .mockImplementationOnce(() => resp(0, ''));                          // git status --porcelain (no hook changes)

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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))                  // claude commit msg
      .mockImplementationOnce(() => resp(0))                                       // git commit
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))                   // claude commit msg
      .mockImplementationOnce(() => resp(0))                                        // git commit
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
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
      .mockImplementationOnce(() => resp(0))                              // git commit
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(1, '', 'pre-push hook: lint failed')) // git push (pre-push hook fails)
      .mockImplementationOnce(() => resp(0, 'M\t.lint-cache\n'))          // git status --porcelain (hook left changes)
      .mockImplementationOnce(() => resp(0))                              // git add -A (stage hook changes)
      .mockImplementationOnce(() => resp(0, 'A\t.lint-cache\n'))          // git diff --cached --stat (fix commit msg)
      .mockImplementationOnce(() => resp(0, 'diff --git a/.lint-cache'))  // git diff --cached --no-color (fix commit msg)
      .mockImplementationOnce(() => resp(0, 'chore: apply lint fixes'))   // claude fix commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit (fix commit)
      .mockImplementationOnce(() => resp(0))                              // git push (retry — succeeds)
      .mockImplementationOnce(() => resp(0, 'def5678'));                  // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    // Verify the fix commit was made
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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
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
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(1, '', 'pre-commit hook failed')) // git commit
      .mockImplementationOnce(() => resp(0, ''));                          // git status --porcelain (no hook changes)

    await startProjectPush('proj');
    expect(createJobMock).toHaveBeenCalled();
    const job = createJobMock.mock.results[0].value;
    expect(markDoneMock).toHaveBeenCalledWith(job, 1);
  });

  it('stages hook-modified files and retries commit when pre-commit hook modifies files', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --name-status (hasStaged)
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --stat (commit msg)
      .mockImplementationOnce(() => resp(0, 'diff --git a/foo.ts'))       // git diff --cached --no-color (commit msg)
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(1, '', 'pre-commit hook failed')) // git commit (first attempt fails)
      .mockImplementationOnce(() => resp(0, 'M\t.lint-cache\n'))          // git status --porcelain (hook left changes)
      .mockImplementationOnce(() => resp(0))                              // git add -A (stage hook changes)
      .mockImplementationOnce(() => resp(0))                              // git commit (retry succeeds)
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                              // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));                  // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    // Verify commit was retried (called twice: first fail, then success)
    const commitCalls = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && args.includes('commit')
    );
    expect(commitCalls.length).toBe(2);
  });

  it('returns commit error when retry after hook-modified files also fails', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --name-status (hasStaged)
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached --stat (commit msg)
      .mockImplementationOnce(() => resp(0, 'diff --git a/foo.ts'))       // git diff --cached --no-color (commit msg)
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(1, '', 'pre-commit hook failed')) // git commit (first attempt fails)
      .mockImplementationOnce(() => resp(0, 'M\t.lint-cache\n'))          // git status --porcelain (hook left changes)
      .mockImplementationOnce(() => resp(0))                              // git add -A (stage hook changes)
      .mockImplementationOnce(() => resp(1, '', 'still failing'));        // git commit (retry also fails)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain('Commit failed');
      expect(r.detail).toContain('still failing');
    }
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Commit failed'));
  });

  it('rebases and retries when push is rejected with "fetch first" (stale tracking info)', async () => {
    // Scenario: local tracking branch is stale so the pre-push behind-check shows 0,
    // but the remote has new commits. After rejection, pull --rebase + retry must succeed.
    execMock
      .mockImplementationOnce(() => resp(0))                                  // git add -A
      .mockImplementationOnce(() => resp(0, ''))                              // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count @{u}..HEAD (1 ahead)
      .mockImplementationOnce(() => resp(0, '# branch.ab +1 -0\n'))          // git status --porcelain=v2 --branch (behind=0)
      .mockImplementationOnce(() => resp(1, '', 'error: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: \'git pull\' before pushing again.')) // git push → fetch first
      .mockImplementationOnce(() => resp(0))                                  // git pull --rebase
      .mockImplementationOnce(() => resp(0))                                  // git push (retry)
      .mockImplementationOnce(() => resp(0, 'abc1234'));                      // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    const rebaseCalls = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && args.includes('pull') && args.includes('--rebase')
    );
    expect(rebaseCalls.length).toBe(1);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('rebases and retries when push is rejected with "fetch first" message variant', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                                  // git add -A
      .mockImplementationOnce(() => resp(0, ''))                              // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count @{u}..HEAD
      .mockImplementationOnce(() => resp(0, '# branch.ab +1 -0\n'))          // behind check (shows 0 behind)
      .mockImplementationOnce(() => resp(1, '', '! [rejected] master -> master (fetch first)')) // git push
      .mockImplementationOnce(() => resp(0))                                  // git pull --rebase
      .mockImplementationOnce(() => resp(0))                                  // git push (retry)
      .mockImplementationOnce(() => resp(0, 'def5678'));                      // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
  });

  it('returns 409 when rebase fails after "fetch first" rejection', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                                  // git add -A
      .mockImplementationOnce(() => resp(0, ''))                              // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.ab +1 -0\n'))          // behind check
      .mockImplementationOnce(() => resp(1, '', 'Updates were rejected because the remote contains work'))  // git push
      .mockImplementationOnce(() => resp(1, '', 'CONFLICT: merge conflict in foo.ts')); // git pull --rebase fails

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('Rebase failed');
    }
  });

  it('commitOnly=true commits but skips push and returns ok', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached (staged)
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))               // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'diff --git a/foo.ts'))       // git diff --cached (content)
      .mockImplementationOnce(() => resp(0, 'feat: add feature'))         // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit
      .mockImplementationOnce(() => resp(0, 'abc1234'));                  // git rev-parse

    const r = await startProjectPush('proj', { commitOnly: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('committed');
      expect(r.message).toContain('push skipped');
    }
    // git push should NOT have been called
    const pushCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('push'));
    expect(pushCalls).toHaveLength(0);
  });

  it('commitOnly=true returns ok with "Nothing to commit" when nothing staged and not ahead', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))         // git add -A
      .mockImplementationOnce(() => resp(0, ''))     // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '0'));   // git rev-list --count

    const r = await startProjectPush('proj', { commitOnly: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toContain('Nothing to commit');
    // push not called
    const pushCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('push'));
    expect(pushCalls).toHaveLength(0);
  });

  it('commitOnly=true when already ahead and nothing to stage skips push and returns ok', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))         // git add -A
      .mockImplementationOnce(() => resp(0, ''))     // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '1\n')); // git rev-list --count (1 ahead)

    const r = await startProjectPush('proj', { commitOnly: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toContain('committed');
    const pushCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('push'));
    expect(pushCalls).toHaveLength(0);
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

describe('generateCommitMessage', () => {
  let generateCommitMessage: typeof import('@/lib/start-push').generateCommitMessage;
  let execMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({ getSettings: () => ({ commit_style: '' }) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    ({ generateCommitMessage } = await import('@/lib/start-push'));
  });

  afterEach(() => { vi.resetModules(); });

  it('passes --tools "" and --system-prompt to claude to prevent tool use and CLAUDE.md injection', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'file.ts | 1 +'))    // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'diff --git a/file.ts')) // git diff --cached
      .mockImplementationOnce(() => resp(0, 'feat: add feature')); // claude

    await generateCommitMessage('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    expect(claudeCall).toBeTruthy();
    const args: string[] = claudeCall![1];
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('--print');
  });

  it('returns the commit message from a single-line claude response', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'fix(auth): correct token expiry logic'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('fix(auth): correct token expiry logic');
  });

  it('extracts conventional title from multiline response that includes prose', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'Here is the commit title:\n\nfeat(api): add rate limiting middleware'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('feat(api): add rate limiting middleware');
  });

  it('retries when first response matches generic GENERIC_RE pattern', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))                              // git diff --stat
      .mockImplementationOnce(() => resp(0, ''))                              // git diff
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))       // first claude → generic
      .mockImplementationOnce(() => resp(0, 'refactor(push): improve retry logic')); // retry claude

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('refactor(push): improve retry logic');
    const claudeCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'claude');
    expect(claudeCalls).toHaveLength(2);
  });

  it('retries when first response is "chore: update" (bare generic)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: update'))
      .mockImplementationOnce(() => resp(0, 'test(lib): add coverage for push helper'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('test(lib): add coverage for push helper');
  });

  it('retries when first response is empty', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))                              // empty first attempt
      .mockImplementationOnce(() => resp(0, 'chore(deps): bump dependencies'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore(deps): bump dependencies');
  });

  it('returns fallback when both attempts produce no usable output', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))   // first attempt: empty
      .mockImplementationOnce(() => resp(0, ''));  // retry: also empty

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update files');
  });

  it('does not return msg2 when it is also a generic placeholder', async () => {
    // msg1 is empty (triggers retry); msg2 is a generic placeholder.
    // Old behavior: returned msg2 because it was truthy.
    // New behavior: generic msg2 is filtered, falls through to 'chore: update files'.
    execMock
      .mockImplementationOnce(() => resp(0, ''))   // git diff --stat (no files)
      .mockImplementationOnce(() => resp(0, ''))   // git diff (no content)
      .mockImplementationOnce(() => resp(0, ''))   // first claude attempt: empty
      .mockImplementationOnce(() => resp(0, 'chore: update'));  // retry: generic

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).not.toBe('chore: update');
    expect(msg).toBe('chore: update files');
  });

  it('derives chore:update <files> from stat when both claude attempts are generic', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'lib/foo.ts | 3 +++\nlib/bar.ts | 1 -\n 2 files changed'))
      .mockImplementationOnce(() => resp(0, 'diff --git a/lib/foo.ts'))
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))  // first: generic
      .mockImplementationOnce(() => resp(0, 'chore: update'));           // retry: generic

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update lib/foo.ts, lib/bar.ts');
  });

  it('caps file-name fallback at 3 files', async () => {
    const stat = ['a.ts | 1', 'b.ts | 1', 'c.ts | 1', 'd.ts | 1'].join('\n');
    execMock
      .mockImplementationOnce(() => resp(0, stat))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))
      .mockImplementationOnce(() => resp(0, 'chore: update'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update a.ts, b.ts, c.ts');
  });

  it('does not retry when first response is a specific conventional commit (not generic)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore(ci): update workflow permissions'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore(ci): update workflow permissions');
    const claudeCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'claude');
    expect(claudeCalls).toHaveLength(1);
  });

  it('prefers specific conventional line over generic one when both are in output', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: automated update\nfeat(push): add stale-tracking rebase\nchore: update'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('feat(push): add stale-tracking rebase');
  });

  it('includes style guide in prompt when commit_style is set', async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({
      getSettings: () => ({ commit_style: 'Always include a ticket number like PROJ-123.' }),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    const { generateCommitMessage: fn } = await import('@/lib/start-push');

    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'feat: add something'));

    await fn('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    const prompt: string = claudeCall![1][claudeCall![1].indexOf('-p') + 1];
    expect(prompt).toContain('STYLE GUIDE');
    expect(prompt).toContain('Always include a ticket number');
  });

  it('includes diff context (stat + patch) in the prompt', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'lib/foo.ts | 5 +++++'))        // git diff --stat
      .mockImplementationOnce(() => resp(0, 'diff --git a/lib/foo.ts\n+const x = 1;')) // git diff
      .mockImplementationOnce(() => resp(0, 'feat: add foo'));

    await generateCommitMessage('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    const prompt: string = claudeCall![1][claudeCall![1].indexOf('-p') + 1];
    expect(prompt).toContain('lib/foo.ts');
    expect(prompt).toContain('myrepo');
  });
});

describe('launchProjectPush — fire-and-forget', () => {
  let launchProjectPush: typeof import('@/lib/start-push').launchProjectPush;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let setProjectPushResultMock: ReturnType<typeof vi.fn>;
  let mkdirSyncMock: ReturnType<typeof vi.fn>;
  let appendFileSyncMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function flush() {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    setProjectPushResultMock = vi.fn();
    mkdirSyncMock = vi.fn();
    appendFileSyncMock = vi.fn();
    createJobMock = vi.fn().mockImplementation((project: string, kind: string, pid: number, logPath: string) => ({
      id: `${project}-${kind}-launch-id`, project, kind, pid, logPath, prompt: null,
      startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    updateJobMock = vi.fn();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/gh-status', () => ({ invalidateProject: vi.fn() }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({ getSettings: () => ({ commit_style: '' }) }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp/test-logs' }),
      setProjectPushResult: setProjectPushResultMock,
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      markDone: markDoneMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('fs', () => ({
      mkdirSync: mkdirSyncMock,
      appendFileSync: appendFileSyncMock,
    }));

    ({ launchProjectPush } = await import('@/lib/start-push'));
  });

  afterEach(() => { vi.resetModules(); });

  it('returns error object immediately when project path cannot be resolved', () => {
    resolveProjectPathMock.mockReturnValue(null);
    const result = launchProjectPush('nonexistent');
    expect(result).toEqual({ error: 'project not found' });
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('returns jobId synchronously when project exists', () => {
    execMock.mockResolvedValue(resp(0));
    const result = launchProjectPush('proj');
    expect('jobId' in result).toBe(true);
    if ('jobId' in result) {
      expect(typeof result.jobId).toBe('string');
      expect(result.jobId.length).toBeGreaterThan(0);
    }
  });

  it('creates a job and updates it with logPath before returning', () => {
    execMock.mockResolvedValue(resp(0));
    launchProjectPush('proj');
    expect(createJobMock).toHaveBeenCalledWith('proj', 'push', expect.any(Number), '');
    expect(updateJobMock).toHaveBeenCalledOnce();
    const updatedJob = updateJobMock.mock.calls[0][0];
    expect(updatedJob.logPath).toMatch(/\.log$/);
  });

  it('job ID in return value matches the created job ID', () => {
    execMock.mockResolvedValue(resp(0));
    const result = launchProjectPush('proj');
    if ('jobId' in result) {
      const createdJobId = createJobMock.mock.results[0].value.id;
      expect(result.jobId).toBe(createdJobId);
    }
  });

  it('marks job done with exit 0 after successful background push', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, ''))                          // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '0'));                        // git rev-list --count

    launchProjectPush('proj');
    await flush();
    await flush();

    expect(markDoneMock).toHaveBeenCalled();
    const [, exitCode] = markDoneMock.mock.calls[0];
    expect(exitCode).toBe(0);
  });

  it('marks job done with exit 1 after failed background push', async () => {
    execMock
      .mockImplementationOnce(() => resp(0))              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tf.ts\n')) // git diff --cached (staged)
      .mockImplementationOnce(() => resp(0, ''))          // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, ''))          // git diff --cached --no-color
      .mockImplementationOnce(() => resp(0, 'feat: x'))   // claude commit msg
      .mockImplementationOnce(() => resp(1, '', 'pre-commit failed')) // git commit fails
      .mockImplementationOnce(() => resp(0, ''));         // git status --porcelain (no hook changes)

    launchProjectPush('proj');
    await flush();
    await flush();
    await flush();

    expect(markDoneMock).toHaveBeenCalled();
    const [, exitCode] = markDoneMock.mock.calls[0];
    expect(exitCode).toBe(1);
  });

  it('writes a start header to the log file immediately', () => {
    execMock.mockResolvedValue(resp(0));
    launchProjectPush('proj');
    expect(appendFileSyncMock).toHaveBeenCalled();
    const firstWrite: string = appendFileSyncMock.mock.calls[0][1];
    expect(firstWrite).toContain('push start');
    expect(firstWrite).toContain('/path/to/proj');
  });

  it('creates logDir with recursive mkdirSync', () => {
    execMock.mockResolvedValue(resp(0));
    launchProjectPush('proj');
    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/test-logs', { recursive: true });
  });
});
