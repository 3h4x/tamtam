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
});
