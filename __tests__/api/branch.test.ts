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
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/branch/route').GET;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let detectMainBranchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    detectMainBranchMock = vi.fn().mockResolvedValue('main');

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ detectMainBranch: detectMainBranchMock }));

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

  it('returns commitsAhead when on a feature branch with commits ahead of origin/default', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))   // branch --show-current
      .mockResolvedValueOnce(makeExecResult({ stdout: '3\n' }));        // rev-list --count
    detectMainBranchMock.mockResolvedValue('main');
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.commitsAhead).toBe(3);
    // verify rev-list was queried against origin/<default>..HEAD
    const revCall = execMock.mock.calls.find(([cmd, args]) => cmd === 'git' && args.includes('rev-list'));
    expect(revCall?.[1]).toContain('origin/main..HEAD');
  });

  it('returns commitsAhead 0 for a stranded merged branch (no commits ahead of origin)', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-8-stranded\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '0\n' }));
    detectMainBranchMock.mockResolvedValue('main');
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.commitsAhead).toBe(0);
  });

  it('returns commitsAhead null when on the default branch (no rev-list call)', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'main\n' }));
    detectMainBranchMock.mockResolvedValue('main');
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.commitsAhead).toBeNull();
    const revCall = execMock.mock.calls.find(([cmd, args]) => cmd === 'git' && args.includes('rev-list'));
    expect(revCall).toBeUndefined();
  });

  it('returns commitsAhead null when rev-list fails', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 128, stderr: 'unknown revision' }));
    detectMainBranchMock.mockResolvedValue('main');
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.commitsAhead).toBeNull();
  });

  it('returns commitsAhead null when rev-list stdout is non-numeric', async () => {
    // Defensive: a future git change or corrupt repo could emit empty /
    // garbage stdout with exitCode 0. The route must not coerce that into
    // NaN/0 and disable the Create PR button incorrectly — null says
    // "unknown" so the UI can decide whether to render a spinner.
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'feat/x\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '\n' }));
    detectMainBranchMock.mockResolvedValue('main');
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/branch');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.commitsAhead).toBeNull();
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
