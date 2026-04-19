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

describe('POST /api/projects/by-project/[projectName]/push', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn();

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns success with no changes when git add shows nothing staged', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git add -A
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: '' })) // git status --porcelain (empty = no changes)
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })); // commit

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.message).toContain('No changes');
  });

  it('returns 400 when git add fails', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'permission denied' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Git add failed');
  });

  it('returns 400 when commit fails', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git add -A
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M file.ts\n' })) // git status
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'commit error' })); // commit fails

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Commit failed');
  });

  it('returns 400 when push fails', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git add -A
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M file.ts\n' })) // git status
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // commit success
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'push rejected' })); // push fails

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Push failed');
  });

  it('pushes successfully when commit and push succeed', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git add -A
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M file.ts\n' })) // git status
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'master' })) // commit success
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'ok pushed' })); // push success

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.message).toContain('pushed');
  });
});

describe('GET /api/projects/by-project/[projectName]/push/preview', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/preview/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns no changes when git shows nothing', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: '' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files).toEqual([]);
    expect(data.summary).toBe('No changes');
  });

  it('returns files with status from git name-status output', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'M\tsrc/file.ts\nA\tsrc/new.ts\n' })) // diff --name-status
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // ls-files untracked
      .mockResolvedValueOnce(makeExecResult({ stdout: 'src/file.ts | 10 ++++\n2 files changed' })); // diff stat

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(2);
    expect(data.files[0].status).toBe('M');
    expect(data.files[0].filename).toBe('src/file.ts');
    expect(data.files[1].status).toBe('A');
  });

  it('includes untracked files as A status', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // diff name-status (empty)
      .mockResolvedValueOnce(makeExecResult({ stdout: 'new-file.ts\n' })) // untracked
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })); // diff stat

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0].status).toBe('A');
    expect(data.files[0].filename).toBe('new-file.ts');
    expect(data.files[0].stats).toBe('new file');
  });
});

describe('POST /api/projects/by-project/[projectName]/push/execute', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let invalidateProjectMock: ReturnType<typeof vi.fn>;
  let clearProjectDataCacheMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    invalidateProjectMock = vi.fn();
    clearProjectDataCacheMock = vi.fn();

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: clearProjectDataCacheMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/gh-status', () => ({ invalidateProject: invalidateProjectMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/execute/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: update' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns success with empty commit_sha when no staged changes', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git add -A
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: '' })); // diff cached (no changes)

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: update' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.message).toContain('No changes');
    expect(data.commit_sha).toBe('');
  });

  it('commits and pushes with given message', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git add -A
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M\tsrc/file.ts\n' })) // diff cached
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git commit
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +0 -0\n' })) // behind check
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // git push
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'abc1234' })); // rev-parse

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'feat: add something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.commit_sha).toBe('abc1234');
  });

  it('invalidates project cache after successful push', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // add
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M\tfile.ts\n' })) // diff
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // commit
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +0 -0\n' })) // behind check
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // push
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'abc1234' })); // sha

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: update' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(invalidateProjectMock).toHaveBeenCalledWith('myproj');
    expect(clearProjectDataCacheMock).toHaveBeenCalledOnce();
  });

  it('returns 400 when push fails', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // add
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M\tfile.ts\n' })) // diff
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // commit
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +0 -0\n' })) // behind check
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'push rejected' })) // push fails
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'push rejected' })); // retry push also fails

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: update' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Push failed');
  });

  it('auto-rebases when behind remote and then pushes successfully', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // add
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M\tfile.ts\n' })) // diff cached
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // commit
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +2 -3\n' })) // 3 behind
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'Successfully rebased and updated' })) // pull --rebase
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // push
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'def5678' })); // rev-parse

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'feat: new thing' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.commit_sha).toBe('def5678');
  });

  it('returns 409 when rebase fails (conflict)', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // add
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M\tfile.ts\n' })) // diff cached
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // commit
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +0 -2\n' })) // 2 behind
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in file.ts' })); // rebase fails

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'fix: something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('Rebase failed');
  });

  it('strips hint: lines from rebase error detail', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // add
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'M\tfile.ts\n' })) // diff cached
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // commit
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +0 -1\n' })) // 1 behind
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'CONFLICT in file.ts\nhint: use git rebase --continue' }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: update' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.detail).not.toMatch(/hint:/i);
    expect(data.detail).toContain('CONFLICT');
  });
});
