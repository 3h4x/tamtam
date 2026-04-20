import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('GET /api/projects/by-project/[projectName]/behind', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    execMock = vi.fn().mockResolvedValue(makeExecResult());

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

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

  it('returns behind=0 ahead=0 when no branch.ab line', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: '# branch.head master\n' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.behind).toBe(0);
    expect(data.ahead).toBe(0);
  });

  it('returns behind=0 ahead=0 when git exits non-zero', async () => {
    execMock.mockResolvedValue(makeExecResult({ exitCode: 128, stdout: '', stderr: 'not a git repo' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.behind).toBe(0);
    expect(data.ahead).toBe(0);
  });

  it('parses ahead and behind correctly', async () => {
    execMock.mockResolvedValue(makeExecResult({
      stdout: '# branch.head master\n# branch.ab +3 -5\n',
    }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ahead).toBe(3);
    expect(data.behind).toBe(5);
  });

  it('returns behind=0 ahead=0 when branch.ab has zeros', async () => {
    execMock.mockResolvedValue(makeExecResult({
      stdout: '# branch.head main\n# branch.ab +0 -0\n',
    }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.ahead).toBe(0);
    expect(data.behind).toBe(0);
  });

  it('calls git with correct args', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: '# branch.ab +1 -2\n' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/behind');
    await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(execMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/path/to/project', 'status', '--porcelain=v2', '--branch'],
      expect.objectContaining({ timeout: 5000 })
    );
  });
});
