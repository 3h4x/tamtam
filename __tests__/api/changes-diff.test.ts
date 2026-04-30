import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

describe('GET /api/projects/by-project/[projectName]/changes/diff', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/changes/diff/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  function makeReq(projectName: string, file?: string) {
    const url = file
      ? `http://localhost/api/projects/by-project/${projectName}/changes/diff?file=${encodeURIComponent(file)}`
      : `http://localhost/api/projects/by-project/${projectName}/changes/diff`;
    return new NextRequest(url);
  }

  it('returns 400 when file param is missing', async () => {
    const req = makeReq('myproj');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toMatch(/file param required/i);
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = makeReq('unknown', 'src/foo.ts');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toMatch(/project not found/i);
  });

  it('returns diff for tracked file', async () => {
    // ls-files succeeds (exitCode 0) → tracked
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // ls-files
      .mockResolvedValueOnce(makeExecResult({ stdout: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n' })); // diff HEAD

    const req = makeReq('myproj', 'src/foo.ts');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.untracked).toBe(false);
    expect(data.diff).toContain('+new');
  });

  it('returns diff for untracked file', async () => {
    // ls-files fails (exitCode 128) → untracked
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 128, stderr: 'error: pathspec' })) // ls-files
      .mockResolvedValueOnce(makeExecResult({ stdout: '+new file content\n' })); // diff --no-index

    const req = makeReq('myproj', 'src/newfile.ts');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.untracked).toBe(true);
    expect(data.diff).toContain('+new file content');
  });

  it('uses correct git args for tracked file diff', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'some diff' }));

    const req = makeReq('myproj', 'lib/utils.ts');
    await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['-C', '/path/to/proj', 'ls-files', '--error-unmatch', '--', 'lib/utils.ts'],
      { timeout: 5000 }
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['-C', '/path/to/proj', 'diff', 'HEAD', '--', 'lib/utils.ts'],
      { timeout: 15000 }
    );
  });

  it('uses correct git args for untracked file diff', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1 }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'some diff' }));

    const req = makeReq('myproj', 'lib/new.ts');
    await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['-C', '/path/to/proj', 'diff', '--no-index', '--', '/dev/null', 'lib/new.ts'],
      { timeout: 15000 }
    );
  });
});
