import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

describe('GET /api/projects/by-project/[projectName]/changes/diff', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/changes/diff/route').GET;
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

  describe('path traversal protection', () => {
    // The untracked branch runs `git diff --no-index -- /dev/null <file>`
    // which reads any filesystem path the caller supplies. Without these
    // guards, a request like `?file=/etc/passwd` would return the file's
    // contents verbatim. Each test asserts the route rejects the input
    // BEFORE issuing any git invocation.

    it('rejects absolute paths outside the project', async () => {
      const req = makeReq('myproj', '/etc/passwd');
      const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toMatch(/outside project/i);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('rejects relative traversal that escapes the project root', async () => {
      const req = makeReq('myproj', '../../etc/passwd');
      const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toMatch(/outside project/i);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('rejects exact parent directory traversal', async () => {
      const req = makeReq('myproj', '..');
      const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toMatch(/outside project/i);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('rejects paths that resolve to the project root itself', async () => {
      const req = makeReq('myproj', '.');
      const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(400);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('accepts paths that resolve to a file inside the project (defense not over-zealous)', async () => {
      execMock
        .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
        .mockResolvedValueOnce(makeExecResult({ stdout: 'diff content' }));
      // `subdir/../foo.ts` normalises to `foo.ts` — still inside the project.
      const req = makeReq('myproj', 'subdir/../foo.ts');
      const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(200);
      // Git is invoked with the normalized path, not the raw traversal.
      expect(execMock).toHaveBeenNthCalledWith(
        1,
        'git',
        ['-C', '/path/to/proj', 'ls-files', '--error-unmatch', '--', 'foo.ts'],
        { timeout: 5000 }
      );
    });

    it('accepts in-project filenames that start with two dots', async () => {
      execMock
        .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
        .mockResolvedValueOnce(makeExecResult({ stdout: 'diff content' }));
      const req = makeReq('myproj', '..foo.ts');
      const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(200);
      expect(execMock).toHaveBeenNthCalledWith(
        1,
        'git',
        ['-C', '/path/to/proj', 'ls-files', '--error-unmatch', '--', '..foo.ts'],
        { timeout: 5000 }
      );
    });

    it('accepts absolute paths that point inside the project', async () => {
      execMock
        .mockResolvedValueOnce(makeExecResult({ exitCode: 0 }))
        .mockResolvedValueOnce(makeExecResult({ stdout: 'diff content' }));
      const req = makeReq('myproj', '/path/to/proj/src/foo.ts');
      const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(200);
      expect(execMock).toHaveBeenNthCalledWith(
        1,
        'git',
        ['-C', '/path/to/proj', 'ls-files', '--error-unmatch', '--', 'src/foo.ts'],
        { timeout: 5000 }
      );
    });

    it('rejects untracked paths that resolve outside via an in-project symlink directory', async () => {
      const root = mkdtempSync(join(tmpdir(), 'changes-diff-symlink-'));
      const projectDir = join(root, 'project');
      const outsideDir = join(root, 'outside');
      mkdirSync(projectDir);
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
      symlinkSync(outsideDir, join(projectDir, 'linkdir'), 'dir');
      resolveProjectPathMock.mockReturnValue(projectDir);
      execMock.mockResolvedValueOnce(makeExecResult({ exitCode: 1 }));

      try {
        const req = makeReq('myproj', 'linkdir/secret.txt');
        const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.detail).toMatch(/outside project/i);
        expect(execMock).toHaveBeenCalledTimes(1);
        expect(execMock).toHaveBeenNthCalledWith(
          1,
          'git',
          ['-C', projectDir, 'ls-files', '--error-unmatch', '--', 'linkdir/secret.txt'],
          { timeout: 5000 }
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
