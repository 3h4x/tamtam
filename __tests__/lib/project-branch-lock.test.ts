import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('project-branch-lock', () => {
  let getIssueBranchLock: typeof import('@/lib/project-branch-lock').getIssueBranchLock;
  let clearIssueBranchLockCache: typeof import('@/lib/project-branch-lock').clearIssueBranchLockCache;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    ({ getIssueBranchLock, clearIssueBranchLockCache } = await import('@/lib/project-branch-lock'));
  });

  afterEach(() => {
    vi.resetModules();
  });

  // ── Project path resolution ───────────────────────────────────────────────

  it('returns null when the project is not found in the registry', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const result = await getIssueBranchLock('unknown');
    expect(result).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });

  // ── Branch detection ──────────────────────────────────────────────────────

  it('returns the branch name when on a fix/issue-N branch', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'fix/issue-7-my-bug\n' }));
    const result = await getIssueBranchLock('myproj');
    expect(result).toBe('fix/issue-7-my-bug');
  });

  it('returns the branch name for any fix/issue-N-... slug', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'fix/issue-123-handle-edge-cases\n' }));
    const result = await getIssueBranchLock('myproj');
    expect(result).toBe('fix/issue-123-handle-edge-cases');
  });

  it('returns null when on the default (main) branch', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'main\n' }));
    const result = await getIssueBranchLock('myproj');
    expect(result).toBeNull();
  });

  it('returns null when on a non-issue feature branch', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'feat/add-widget\n' }));
    const result = await getIssueBranchLock('myproj');
    expect(result).toBeNull();
  });

  it('returns null when git exits non-zero', async () => {
    execMock.mockResolvedValue(makeExecResult({ exitCode: 128, stderr: 'not a git repo' }));
    const result = await getIssueBranchLock('myproj');
    expect(result).toBeNull();
  });

  it('returns null when exec throws (git missing / timeout)', async () => {
    execMock.mockRejectedValue(new Error('spawn ENOENT'));
    const result = await getIssueBranchLock('myproj');
    expect(result).toBeNull();
  });

  it('returns null when branch output is empty', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: '\n' }));
    const result = await getIssueBranchLock('myproj');
    expect(result).toBeNull();
  });

  // ── TTL cache ─────────────────────────────────────────────────────────────

  it('returns cached value without shelling out a second time within TTL', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'fix/issue-3-bug\n' }));

    await getIssueBranchLock('myproj');
    await getIssueBranchLock('myproj');

    expect(execMock).toHaveBeenCalledOnce();
  });

  it('caches null results (unlocked) within TTL', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'main\n' }));

    const r1 = await getIssueBranchLock('myproj');
    const r2 = await getIssueBranchLock('myproj');

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(execMock).toHaveBeenCalledOnce();
  });

  it('caches independently per project', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-1-a\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-2-b\n' }));

    const r1 = await getIssueBranchLock('proj-a');
    const r2 = await getIssueBranchLock('proj-b');

    expect(r1).toBe('fix/issue-1-a');
    expect(r2).toBe('fix/issue-2-b');
    expect(execMock).toHaveBeenCalledTimes(2);

    // Second calls hit cache
    await getIssueBranchLock('proj-a');
    await getIssueBranchLock('proj-b');
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  // ── clearIssueBranchLockCache ─────────────────────────────────────────────

  it('clears cached state for a specific project so next call shells out again', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'fix/issue-5-x\n' }));

    await getIssueBranchLock('myproj');
    clearIssueBranchLockCache('myproj');
    await getIssueBranchLock('myproj');

    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('clears all cached entries when called with no argument', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'fix/issue-1-a\n' }));

    await getIssueBranchLock('proj-a');
    await getIssueBranchLock('proj-b');
    clearIssueBranchLockCache(); // clear all
    await getIssueBranchLock('proj-a');
    await getIssueBranchLock('proj-b');

    expect(execMock).toHaveBeenCalledTimes(4);
  });

  it('does not clear other projects when clearing by name', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'main\n' }));

    await getIssueBranchLock('proj-a');
    await getIssueBranchLock('proj-b');
    clearIssueBranchLockCache('proj-a'); // only clear proj-a

    await getIssueBranchLock('proj-a'); // re-fetches
    await getIssueBranchLock('proj-b'); // still cached

    expect(execMock).toHaveBeenCalledTimes(3);
  });
});
