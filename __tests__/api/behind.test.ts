import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('GET /api/projects/by-project/[projectName]/behind', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/behind/route').GET;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    execMock = vi.fn();

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/behind/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns behind=0 ahead=0 when upstream rev-parse fails (no tracking branch)', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ exitCode: 128, stderr: 'no upstream' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ behind: 0, ahead: 0 });
    // Should NOT have attempted fetch / rev-list once upstream resolution failed.
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('returns behind=0 ahead=0 when upstream is blank', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: '\n' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data).toEqual({ behind: 0, ahead: 0 });
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('returns behind=0 ahead=0 when rev-list exits non-zero', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'origin/main\n' })) // rev-parse @{u}
      .mockResolvedValueOnce(makeExecResult()) // fetch
      .mockResolvedValueOnce(makeExecResult({ exitCode: 128, stderr: 'not a git repo' })); // rev-list
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ behind: 0, ahead: 0 });
  });

  it('parses ahead and behind from rev-list --count --left-right output', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'origin/main\n' }))
      .mockResolvedValueOnce(makeExecResult()) // fetch
      .mockResolvedValueOnce(makeExecResult({ stdout: '3\t5\n' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ahead: 3, behind: 5 });
  });

  it('returns zeros when rev-list reports clean divergence', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'origin/main\n' }))
      .mockResolvedValueOnce(makeExecResult())
      .mockResolvedValueOnce(makeExecResult({ stdout: '0\t0\n' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data).toEqual({ ahead: 0, behind: 0 });
  });

  it('targets the upstream branch for fetch even with nested ref names', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'upstream/feature/sub-branch\n' }))
      .mockResolvedValueOnce(makeExecResult())
      .mockResolvedValueOnce(makeExecResult({ stdout: '1\t2\n' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    // First call resolves upstream, second fetches it, third counts divergence.
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['-C', '/path/to/project', 'rev-parse', '--abbrev-ref', '@{u}'],
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['-C', '/path/to/project', 'fetch', '--quiet', 'upstream', 'feature/sub-branch'],
      expect.objectContaining({ timeout: 10000 }),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      3,
      'git',
      ['-C', '/path/to/project', 'rev-list', '--count', '--left-right', 'HEAD...@{u}'],
      expect.objectContaining({ timeout: 5000 }),
    );
  });
});
