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

describe('GET /api/projects/by-project/[projectName]/changes', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    statSyncMock = vi.fn().mockReturnValue({ size: 1024 });

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('fs', () => ({ statSync: statSyncMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/changes/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns empty files with totals at 0 when no changes', async () => {
    execMock.mockResolvedValue(makeExecResult({ stdout: '' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files).toEqual([]);
    expect(data.totalFiles).toBe(0);
    expect(data.totalAdditions).toBe(0);
    expect(data.totalDeletions).toBe(0);
  });

  it('returns files with additions and deletions from numstat', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'M\tsrc/a.ts\nA\tsrc/b.ts\n' })) // name-status
      .mockResolvedValueOnce(makeExecResult({ stdout: '10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n' })) // numstat
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // untracked
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +0 -0\n' })); // porcelain

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(2);
    expect(data.files[0]).toMatchObject({ status: 'M', filename: 'src/a.ts', additions: 10, deletions: 2, binary: false });
    expect(data.files[1]).toMatchObject({ status: 'A', filename: 'src/b.ts', additions: 5, deletions: 0, binary: false });
    expect(data.totalAdditions).toBe(15);
    expect(data.totalDeletions).toBe(2);
    expect(data.branch).toBe('master');
  });

  it('marks files as binary when numstat reports -/-', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'M\timage.png\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '-\t-\timage.png\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n' }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files[0]).toMatchObject({ filename: 'image.png', binary: true, additions: 0, deletions: 0 });
  });

  it('includes untracked files as A with addition count from diff --no-index', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // name-status empty
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // numstat empty
      .mockResolvedValueOnce(makeExecResult({ stdout: 'new.ts\n' })) // untracked
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n' })) // porcelain
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stdout: '7\t0\t/dev/null\n' })); // diff --no-index

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({ status: 'A', filename: 'new.ts', additions: 7, deletions: 0 });
    expect(data.totalAdditions).toBe(7);
  });

  it('does not duplicate untracked files already in name-status', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'A\tnew.ts\n' })) // name-status (already staged? unlikely but guard)
      .mockResolvedValueOnce(makeExecResult({ stdout: '3\t0\tnew.ts\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'new.ts\n' })) // untracked (duplicate)
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n' }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0].filename).toBe('new.ts');
  });

  it('marks untracked files >2MB as binary without reading diff', async () => {
    statSyncMock.mockReturnValue({ size: 3 * 1024 * 1024 });
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'big.bin\n' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n' }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files[0]).toMatchObject({ filename: 'big.bin', binary: true });
  });
});

describe('GET /api/projects/by-project/[projectName]/changes/diff', () => {
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

    const mod = await import('@/app/api/projects/by-project/[projectName]/changes/diff/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/changes/diff?file=a.ts');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 when file param is missing', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes/diff');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
  });

  it('returns tracked diff when file is tracked', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'a.ts\n' })) // ls-files
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: 'diff content' })); // diff HEAD

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes/diff?file=a.ts');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.diff).toBe('diff content');
    expect(data.untracked).toBe(false);
  });

  it('returns untracked diff when file is not tracked', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'did not match' })) // ls-files fails
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stdout: 'new file diff' })); // diff --no-index

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes/diff?file=new.ts');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.diff).toBe('new file diff');
    expect(data.untracked).toBe(true);
  });
});
