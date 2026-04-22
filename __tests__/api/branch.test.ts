import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

describe('GET /api/projects/by-project/[projectName]/branch', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let detectMainBranchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    detectMainBranchMock = vi.fn().mockResolvedValue('main');

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/start-commit', () => ({ detectMainBranch: detectMainBranchMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/branch/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns current branch and default branch', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' }));
    detectMainBranchMock.mockResolvedValue('main');

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBe('feat/my-branch');
    expect(data.defaultBranch).toBe('main');
  });

  it('returns null branch when detached HEAD (empty stdout)', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: '\n' }));
    detectMainBranchMock.mockResolvedValue('master');

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBeNull();
    expect(data.defaultBranch).toBe('master');
  });

  it('invokes git with the resolved project path', async () => {
    resolveProjectPathMock.mockReturnValue('/custom/repo');
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }));

    await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(execMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/custom/repo', 'branch', '--show-current'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(detectMainBranchMock).toHaveBeenCalledWith('/custom/repo');
  });
});
