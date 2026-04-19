import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startProjectPush — push result tracking', () => {
  let startProjectPush: typeof import('@/lib/start-push').startProjectPush;
  let execMock: ReturnType<typeof vi.fn>;
  let setProjectPushResultMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    setProjectPushResultMock = vi.fn();

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

    ({ startProjectPush } = await import('@/lib/start-push'));
  });

  afterEach(() => { vi.resetModules(); });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  it('stores null error on successful push', async () => {
    // git add -A, diff --cached (staged), claude commit msg, git commit, git push, rev-parse
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))               // git diff --cached
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))               // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))               // git status --porcelain
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit
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
      .mockImplementationOnce(() => resp(0, ''))                          // git status --porcelain
      .mockImplementationOnce(() => resp(0, 'chore: update'))             // claude commit msg
      .mockImplementationOnce(() => resp(0))                              // git commit
      .mockImplementationOnce(() => resp(1, '', 'remote rejected: permission denied')); // git push

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
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))                        // git status --porcelain
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
      .mockImplementationOnce(() => resp(0))                                       // git add -A
      .mockImplementationOnce(() => resp(0, 'A\tfoo.ts\n'))                        // git diff --cached
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))                        // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'M\tfoo.ts\n'))                        // git status --porcelain
      .mockImplementationOnce(() => resp(0, 'chore: update'))                      // claude commit msg
      .mockImplementationOnce(() => resp(0))                                       // git commit
      .mockImplementationOnce(() => resp(1, '', 'error: no upstream branch'))      // git push (no upstream)
      .mockImplementationOnce(() => resp(0, 'feature-x'))                          // git branch --show-current
      .mockImplementationOnce(() => resp(1, '', 'remote: permission denied'));     // git push -u (also fails)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.detail).toContain('Push failed');
    }
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Push failed'));
  });

  it('does not throw when setProjectPushResult throws', async () => {
    setProjectPushResultMock.mockImplementation(() => { throw new Error('DB locked'); });
    execMock
      .mockImplementationOnce(() => resp(0))                              // git add -A
      .mockImplementationOnce(() => resp(0, ''))                          // git diff --cached (nothing staged)
      .mockImplementationOnce(() => resp(0, '0'));                        // git rev-list --count

    await expect(startProjectPush('proj')).resolves.not.toThrow();
  });
});
