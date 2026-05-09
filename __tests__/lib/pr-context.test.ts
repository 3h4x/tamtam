import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('decidePrContext', () => {
  let decidePrContext: typeof import('@/lib/pipeline/pr-context').decidePrContext;
  let execMock: ReturnType<typeof vi.fn>;
  let detectMainBranchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    detectMainBranchMock = vi.fn();

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ detectMainBranch: detectMainBranchMock }));

    ({ decidePrContext } = await import('@/lib/pipeline/pr-context'));
  });

  it('opens a PR when the current branch differs from the default branch', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'feature/alpha\n', stderr: '' });
    detectMainBranchMock.mockResolvedValue('main');

    const result = await decidePrContext('/proj');

    expect(result).toEqual({
      shouldOpenPr: true,
      reason: "current branch 'feature/alpha' differs from default 'main'",
      currentBranch: 'feature/alpha',
      defaultBranch: 'main',
    });
  });

  it('pushes directly when already on the default branch', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'main\n', stderr: '' });
    detectMainBranchMock.mockResolvedValue('main');

    const result = await decidePrContext('/proj');

    expect(result.shouldOpenPr).toBe(false);
    expect(result.currentBranch).toBe('main');
    expect(result.defaultBranch).toBe('main');
    expect(result.reason).toContain("matches default 'main'");
  });
});
