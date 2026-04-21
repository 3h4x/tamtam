import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/pr-branch', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  function makeRequest(body: unknown) {
    return new NextRequest('http://localhost/api/projects/by-project/myproj/pr-branch', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    // Default: branch --show-current returns 'main', both checkouts succeed
    execMock = vi.fn()
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }))  // branch --show-current
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))        // fetch origin
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));       // checkout

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/pr-branch/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  // ── Project lookup ────────────────────────────────────────────────────────

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await POST(makeRequest({ branch: 'feat/my-branch' }), {
      params: Promise.resolve({ projectName: 'unknown' }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it('returns 400 when body is invalid JSON', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/pr-branch', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid JSON');
  });

  it('returns 400 when branch is missing', async () => {
    const res = await POST(makeRequest({}), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('branch required');
  });

  it('returns 400 when branch is empty string', async () => {
    const res = await POST(makeRequest({ branch: '' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('branch required');
  });

  it('returns 400 when branch is whitespace only', async () => {
    const res = await POST(makeRequest({ branch: '   ' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('branch required');
  });

  it('returns 400 when branch starts with a dash (flag injection)', async () => {
    const res = await POST(makeRequest({ branch: '-flag' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid branch name');
  });

  it('returns 400 when branch starts with double-dash (flag injection)', async () => {
    const res = await POST(makeRequest({ branch: '--option=bad' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid branch name');
  });

  it('returns 400 when branch contains a space', async () => {
    const res = await POST(makeRequest({ branch: 'feat/my branch' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid branch name');
  });

  it('returns 400 when branch contains a tab character', async () => {
    const res = await POST(makeRequest({ branch: 'feat/my\tbranch' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid branch name');
  });

  it('returns 400 when branch contains a null byte', async () => {
    // Specifically exercises the branch.includes('\0') path added in the refactor
    const res = await POST(makeRequest({ branch: 'feat/bad\x00name' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid branch name');
  });

  it('returns 400 when branch is only a null byte', async () => {
    const res = await POST(makeRequest({ branch: '\x00' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBe('invalid branch name');
  });

  // ── Happy path: already on branch ────────────────────────────────────────

  it('returns already-on-branch when already on the requested branch', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' }));

    const res = await POST(makeRequest({ branch: 'feat/my-branch' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('already-on-branch');
    expect(data.branch).toBe('feat/my-branch');
    // No further git commands should be run
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  // ── Happy path: switch / create ───────────────────────────────────────────

  it('returns switched when local checkout succeeds', async () => {
    execMock.mockReset();
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }))   // branch --show-current
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))         // fetch origin
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));        // checkout (success)

    const res = await POST(makeRequest({ branch: 'feat/existing' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('switched');
    expect(data.branch).toBe('feat/existing');
  });

  it('returns created when local checkout fails but track-from-origin succeeds', async () => {
    execMock.mockReset();
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }))             // branch --show-current
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))                   // fetch origin
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'err' }))    // checkout (fail)
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));                  // checkout -b --track (success)

    const res = await POST(makeRequest({ branch: 'feat/new-branch' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('created');
    expect(data.branch).toBe('feat/new-branch');
  });

  // ── Failure paths ─────────────────────────────────────────────────────────

  it('returns 500 when both checkout methods fail', async () => {
    execMock.mockReset();
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'no local branch' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'no remote branch' }));

    const res = await POST(makeRequest({ branch: 'feat/ghost' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('Failed to checkout feat/ghost');
  });

  // ── Git command args ──────────────────────────────────────────────────────

  it('passes the branch name to git fetch and checkout', async () => {
    execMock.mockReset();
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));

    await POST(makeRequest({ branch: 'fix/issue-99-some-bug' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });

    const calls = execMock.mock.calls;
    // fetch call should include the branch name
    expect(calls[1][1]).toContain('fix/issue-99-some-bug');
    // checkout call should include the branch name
    expect(calls[2][1]).toContain('fix/issue-99-some-bug');
  });

  it('uses the resolved project path for all git commands', async () => {
    resolveProjectPathMock.mockReturnValue('/custom/path/to/repo');
    execMock.mockReset();
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }));

    await POST(makeRequest({ branch: 'main' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });

    // branch --show-current gets already-on-branch response, so only 1 call
    // Actually 'main' is what --show-current returns in this test mock, so
    // we check the first call uses the right path
    expect(execMock.mock.calls[0][1]).toContain('/custom/path/to/repo');
  });
});
