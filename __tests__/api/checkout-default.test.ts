import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/checkout-default', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let clearProjectDataCacheMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let detectMainBranchMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  function makeRequest() {
    return new NextRequest('http://localhost/api/projects/by-project/myproj/checkout-default', {
      method: 'POST',
    });
  }

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    clearProjectDataCacheMock = vi.fn();
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    detectMainBranchMock = vi.fn().mockResolvedValue('main');

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: clearProjectDataCacheMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ detectMainBranch: detectMainBranchMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/checkout-default/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  // ── Project lookup ────────────────────────────────────────────────────────

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  // ── Dirty working tree guard ──────────────────────────────────────────────

  it('returns 409 when there are uncommitted changes', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: ' M some-file.ts\n' })); // git status --porcelain
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('Uncommitted changes');
  });

  it('returns 409 when there are untracked files in the working tree', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: '?? newfile.ts\n' })); // git status --porcelain
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(409);
  });

  // ── Already on default branch ─────────────────────────────────────────────

  it('returns already-on-branch when already on the default branch', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))          // git status --porcelain (clean)
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }));   // git branch --show-current
    detectMainBranchMock.mockResolvedValue('main');

    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('already-on-branch');
    expect(data.branch).toBe('main');
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('checks out the default branch and returns switched from an issue branch without GitHub lookups', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // git status --porcelain
      .mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-7-login\n' })) // git branch --show-current
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // fetch
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\n' })) // rev-list (ahead)
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })); // git checkout main
    detectMainBranchMock.mockResolvedValue('main');

    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('switched');
    expect(data.branch).toBe('main');
  });

  it('does not shell out to gh while switching branches', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-7-login\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    detectMainBranchMock.mockResolvedValue('main');

    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(execMock.mock.calls.some(([cmd]) => cmd === 'gh')).toBe(false);
  });

  it('calls clear caches after a successful checkout', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    detectMainBranchMock.mockResolvedValue('main');

    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(clearProjectDataCacheMock).toHaveBeenCalledTimes(1);
  });

  it('works with master as the default branch', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/y\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    detectMainBranchMock.mockResolvedValue('master');

    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBe('master');

    const checkoutCall = execMock.mock.calls.find(
      (call) => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('checkout') && call[1].includes('master'),
    );
    expect(checkoutCall).toBeTruthy();
  });

  // ── Checkout failure ──────────────────────────────────────────────────────

  it('returns 500 when git checkout fails', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))                      // status
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))              // branch --show-current
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))                     // fetch
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\n' }))                   // rev-list (ahead)
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'error: cannot switch branch' })); // checkout
    detectMainBranchMock.mockResolvedValue('main');

    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('Failed to checkout main');
    expect(data.detail).toContain('error: cannot switch branch');
  });

  it('does not call clearProjectDataCache when checkout fails', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))                     // fetch
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\n' }))                   // rev-list (ahead)
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'fail' }));    // checkout
    detectMainBranchMock.mockResolvedValue('main');

    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(clearProjectDataCacheMock).not.toHaveBeenCalled();
  });

  // ── Git command args ──────────────────────────────────────────────────────

  it('uses the resolved project path in all git commands', async () => {
    resolveProjectPathMock.mockReturnValue('/custom/repo');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    detectMainBranchMock.mockResolvedValue('main');

    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });

    for (const [cmd, args] of execMock.mock.calls) {
      if (cmd === 'git') {
        expect(args).toContain('/custom/repo');
      }
    }
  });

  it('passes --ignore-submodules to git status', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }));
    detectMainBranchMock.mockResolvedValue('main');

    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });

    const statusCall = execMock.mock.calls[0];
    expect(statusCall[1]).toContain('--ignore-submodules');
    expect(statusCall[1]).toContain('--porcelain');
  });
});
