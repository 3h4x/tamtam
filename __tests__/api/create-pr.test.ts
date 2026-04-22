import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/create-pr', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let detectMainBranchMock: ReturnType<typeof vi.fn>;
  let pushCurrentBranchMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  function makeRequest() {
    return new NextRequest('http://localhost/api/projects/by-project/myproj/create-pr', {
      method: 'POST',
    });
  }

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    execMock = vi.fn();
    detectMainBranchMock = vi.fn().mockResolvedValue('main');
    pushCurrentBranchMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc123' });

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/start-commit', () => ({ detectMainBranch: detectMainBranchMock }));
    vi.doMock('@/lib/start-push', () => ({ pushCurrentBranch: pushCurrentBranchMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/create-pr/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project is not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('Project not found');
  });

  it('returns 400 when HEAD is detached (no current branch)', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: '' }));
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('detached HEAD');
  });

  it('returns 400 when on the default branch', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' })); // branch --show-current
    detectMainBranchMock.mockResolvedValue('main');
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('default branch');
    // Should not have attempted to push
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when on a non-standard default branch (e.g. trunk)', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'trunk\n' }));
    detectMainBranchMock.mockResolvedValue('trunk');
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('trunk');
  });

  it('returns 500 when git push fails', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' }));
    pushCurrentBranchMock.mockResolvedValue({ ok: false, detail: 'Push failed: auth denied' });
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('Push failed');
    expect(data.detail).toContain('auth denied');
  });

  it('returns 500 when gh pr create fails', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' })) // branch
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'gh: not authenticated' })); // gh pr create
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('gh: not authenticated');
  });

  it('extracts the PR URL from gh output and returns it', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' }))
      .mockResolvedValueOnce(makeExecResult({
        stdout: 'Creating pull request for feat/my-branch into main in owner/repo\n\nhttps://github.com/owner/repo/pull/42\n',
      }));
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe('https://github.com/owner/repo/pull/42');
  });

  it('picks the trailing PR URL when preamble references another PR', async () => {
    // gh may emit preamble lines containing other pull URLs (e.g. a referenced
    // PR in the commit body); the newly-created PR link is always last.
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' }))
      .mockResolvedValueOnce(makeExecResult({
        stdout: 'Refs https://github.com/owner/repo/pull/1\nhttps://github.com/owner/repo/pull/7\n',
      }));
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.url).toBe('https://github.com/owner/repo/pull/7');
  });

  it('returns null url when gh output does not contain a PR link', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'something unexpected\n' }));
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBeNull();
  });

  it('delegates push to the shared helper with the resolved project path', async () => {
    resolveProjectPathMock.mockReturnValue('/custom/repo');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'https://github.com/o/r/pull/1\n' }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(pushCurrentBranchMock).toHaveBeenCalledWith('/custom/repo');
  });
});
