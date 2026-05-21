import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('getDirtyFileCount', () => {
  let getDirtyFileCount: typeof import('@/lib/git/dirty-worktree').getDirtyFileCount;
  let clearDirtyWorktreeCache: typeof import('@/lib/git/dirty-worktree').clearDirtyWorktreeCache;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    ({ getDirtyFileCount, clearDirtyWorktreeCache } = await import('@/lib/git/dirty-worktree'));
    clearDirtyWorktreeCache();
  });

  it('returns 0 for a clean worktree', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    expect(await getDirtyFileCount('/proj')).toBe(0);
  });

  it('counts each porcelain line including untracked', async () => {
    execMock.mockResolvedValue({
      exitCode: 0,
      stdout: ' M lib/a.ts\n M lib/b.ts\n?? lib/c.ts\n',
      stderr: '',
    });
    expect(await getDirtyFileCount('/proj')).toBe(3);
  });

  it('returns 0 when git fails (fail-open)', async () => {
    execMock.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
    expect(await getDirtyFileCount('/proj')).toBe(0);
  });

  it('returns 0 when exec throws', async () => {
    execMock.mockRejectedValue(new Error('boom'));
    expect(await getDirtyFileCount('/proj')).toBe(0);
  });

  it('caches results within the TTL window', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: ' M a\n', stderr: '' });
    expect(await getDirtyFileCount('/proj')).toBe(1);
    expect(await getDirtyFileCount('/proj')).toBe(1);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('caches per-project independently', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n M b\n', stderr: '' });
    expect(await getDirtyFileCount('/proj-a')).toBe(1);
    expect(await getDirtyFileCount('/proj-b')).toBe(2);
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('clearDirtyWorktreeCache(path) drops only the named project', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n M b\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n M c\n M d\n', stderr: '' });
    await getDirtyFileCount('/proj-a'); // 1 (cached)
    await getDirtyFileCount('/proj-b'); // 2 (cached)
    clearDirtyWorktreeCache('/proj-a');
    // proj-a re-fetched → 3 lines
    expect(await getDirtyFileCount('/proj-a')).toBe(3);
    // proj-b still served from cache → no extra exec call
    expect(await getDirtyFileCount('/proj-b')).toBe(2);
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it('clearDirtyWorktreeCache() with no argument drops every cached project', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n M b\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await getDirtyFileCount('/proj-a');
    await getDirtyFileCount('/proj-b');
    clearDirtyWorktreeCache();
    expect(await getDirtyFileCount('/proj-a')).toBe(0);
    expect(await getDirtyFileCount('/proj-b')).toBe(0);
    expect(execMock).toHaveBeenCalledTimes(4);
  });

  it('re-fetches after the 5s TTL expires', async () => {
    vi.useFakeTimers();
    try {
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: ' M a\n M b\n', stderr: '' });
      expect(await getDirtyFileCount('/proj')).toBe(1);
      vi.advanceTimersByTime(5_001);
      expect(await getDirtyFileCount('/proj')).toBe(2);
      expect(execMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
