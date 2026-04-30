import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/issue-branch', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  function makeRequest(body: unknown) {
    return new NextRequest('http://localhost/api/projects/by-project/myproj/issue-branch', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    // Default: no per-project row → issueAutoBranch defaults to ON (legacy).
    getProjectTestConfigMock = vi.fn().mockReturnValue(null);

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: getProjectTestConfigMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/issue-branch/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await POST(makeRequest({ issue_number: 1 }), {
      params: Promise.resolve({ projectName: 'unknown' }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issue-branch', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid JSON');
  });

  it('returns 400 when issue_number is missing', async () => {
    const res = await POST(makeRequest({}), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('issue_number required');
  });

  it('returns 400 when issue_number is zero', async () => {
    const res = await POST(makeRequest({ issue_number: 0 }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('issue_number required');
  });

  it('returns 400 when issue_number is negative', async () => {
    const res = await POST(makeRequest({ issue_number: -5 }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns already-on-branch when already on correct branch', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: 'fix/issue-7-my-bug\n' }));
    const res = await POST(makeRequest({ issue_number: 7, issue_title: 'My Bug' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('already-on-branch');
    expect(data.branch).toBe('fix/issue-7-my-bug');
  });

  it('returns created when checkout -b succeeds', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'master\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    const res = await POST(makeRequest({ issue_number: 42, issue_title: 'Add feature' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('created');
    expect(data.branch).toBe('fix/issue-42-add-feature');
  });

  it('returns reused when checkout -b fails but checkout succeeds', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'master\n' }))                       // branch --show-current
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/master\n' }))   // symbolic-ref
      .mockResolvedValueOnce(makeExecResult({ stdout: '  master\n  other\n' }))            // branch --merged (no match)
      .mockResolvedValueOnce(makeExecResult({ exitCode: 128, stderr: 'branch already exists' })) // checkout -b
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));                             // checkout
    const res = await POST(makeRequest({ issue_number: 3, issue_title: 'fix bug' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('reused');
    expect(data.branch).toBe('fix/issue-3-fix-bug');
  });

  it('returns 500 when both checkouts fail', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'master\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/master\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '  master\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 128, stderr: 'branch exists' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'error' }));
    const res = await POST(makeRequest({ issue_number: 5 }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('Failed to checkout');
  });

  it('skips checkout when branch is already merged into default', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'master\n' }))                                  // branch --show-current
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/master\n' }))              // symbolic-ref
      .mockResolvedValueOnce(makeExecResult({ stdout: '  master\n  fix/issue-9-already-merged\n' })); // branch --merged
    const res = await POST(
      makeRequest({ issue_number: 9, issue_title: 'already merged' }),
      { params: Promise.resolve({ projectName: 'myproj' }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('skipped');
    expect(data.reason).toContain('already merged');
    // The checkout must not have been attempted.
    const checkoutCall = execMock.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1].includes('checkout'),
    );
    expect(checkoutCall).toBeUndefined();
  });

  it('slugifies the title correctly', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'master\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    const res = await POST(
      makeRequest({ issue_number: 10, issue_title: 'Fix: Handle NULL values & edge cases!' }),
      { params: Promise.resolve({ projectName: 'myproj' }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBe('fix/issue-10-fix-handle-null-values-edge-cases');
  });

  it('uses branch without slug when title is empty', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'master\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    const res = await POST(makeRequest({ issue_number: 99 }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBe('fix/issue-99');
  });

  it('returns skipped and runs NO git commands when issue_auto_branch is disabled for the project', async () => {
    // User unchecked "Create feature branch" in Config → When you click Work on.
    // The endpoint must short-circuit without touching the working tree so the
    // terminal flow falls through to prompt auto-submit on whatever branch the
    // user is currently on.
    getProjectTestConfigMock.mockReturnValue({
      testCommand: null, testCronEnabled: false, testCronSchedule: null,
      autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false,
      autoPrMergeEnabled: false, issueAutoBranch: false,
    });
    const res = await POST(makeRequest({ issue_number: 42, issue_title: 'x' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('skipped');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('still creates the branch when issue_auto_branch is true', async () => {
    getProjectTestConfigMock.mockReturnValue({
      testCommand: null, testCronEnabled: false, testCronSchedule: null,
      autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false,
      autoPrMergeEnabled: false, issueAutoBranch: true,
    });
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'master\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));
    const res = await POST(makeRequest({ issue_number: 11, issue_title: 'Something' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('created');
    expect(data.branch).toBe('fix/issue-11-something');
    expect(execMock).toHaveBeenCalled();
  });
});
