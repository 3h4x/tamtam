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
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/changes/route').GET;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    statSyncMock = vi.fn().mockReturnValue({ size: 1024 });

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
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
      .mockResolvedValueOnce(makeExecResult({ stdout: '10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n' })) // numstat
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head master\n# branch.ab +0 -0\n1 M. N... 100644 100644 100644 aaa bbb src/a.ts\n1 A. N... 000000 100644 100644 000 ccc src/b.ts\n' })); // porcelain (--branch + entries)

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
      .mockResolvedValueOnce(makeExecResult({ stdout: '-\t-\timage.png\n' })) // numstat (binary)
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n1 M. N... 100644 100644 100644 aaa bbb image.png\n' })); // porcelain

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files[0]).toMatchObject({ filename: 'image.png', binary: true, additions: 0, deletions: 0 });
  });

  it('includes untracked files as A with addition count from diff --no-index', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // numstat empty
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n? new.ts\n' })) // porcelain (untracked entry)
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stdout: '7\t0\t/dev/null\n' })); // diff --no-index

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({ status: 'A', filename: 'new.ts', additions: 7, deletions: 0 });
    expect(data.totalAdditions).toBe(7);
  });

  it('does not double-count a path listed as both tracked and untracked', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '3\t0\tnew.ts\n' })) // numstat
      // Defensive: the same path appears as a tracked add AND (which real git
      // never emits) an untracked `?` entry. The `seen` guard must drop the dup.
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n1 A. N... 000000 100644 100644 000 ccc new.ts\n? new.ts\n' })); // porcelain

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({ status: 'A', filename: 'new.ts', additions: 3 });
  });

  it('marks untracked files >2MB as binary without reading diff', async () => {
    statSyncMock.mockReturnValue({ size: 3 * 1024 * 1024 });
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // numstat
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n? big.bin\n' })); // porcelain (untracked)

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files[0]).toMatchObject({ filename: 'big.bin', binary: true });
  });
});

describe('GET /api/projects/by-project/[projectName]/changes — defaultBranch and branchMerged', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/changes/route').GET;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult());
    statSyncMock = vi.fn().mockReturnValue({ size: 1024 });
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('fs', () => ({ statSync: statSyncMock }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/changes/route');
    GET = mod.GET;
  });

  afterEach(() => { vi.resetModules(); });

  function setupEmptyConcurrentCalls(porcelain: string) {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' })) // numstat
      .mockResolvedValueOnce(makeExecResult({ stdout: porcelain })); // porcelain (--branch + entries)
  }

  it('detects defaultBranch from symbolic-ref when it resolves', async () => {
    setupEmptyConcurrentCalls('# branch.head master\n# branch.ab +0 -0\n');
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })); // symbolic-ref

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.defaultBranch).toBe('main');
  });

  it('falls back to main when symbolic-ref fails but main exists', async () => {
    setupEmptyConcurrentCalls('# branch.head main\n# branch.ab +0 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'not a symbolic ref' })) // symbolic-ref fails
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })); // rev-parse main exists

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.defaultBranch).toBe('main');
  });

  it('falls back to master when symbolic-ref fails and main does not exist', async () => {
    setupEmptyConcurrentCalls('# branch.head master\n# branch.ab +0 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1 })) // symbolic-ref fails
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1 })); // rev-parse main fails

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.defaultBranch).toBe('master');
  });

  it('branchMerged is true when on feature branch with 0 commits ahead of origin/default', async () => {
    setupEmptyConcurrentCalls('# branch.head feature/pr-123\n# branch.ab +0 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/master\n' })) // symbolic-ref → master
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // fetch
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: '0\n' })); // rev-list: 0 commits ahead

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.branchMerged).toBe(true);
    expect(data.branch).toBe('feature/pr-123');
  });

  it('branchMerged is false when on feature branch with commits ahead of origin/default', async () => {
    setupEmptyConcurrentCalls('# branch.head feature/wip\n# branch.ab +3 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/master\n' })) // symbolic-ref
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // fetch
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: '3\n' })); // rev-list: 3 ahead

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.branchMerged).toBe(false);
    expect(data.ahead).toBe(3);
  });

  it('branchMerged is false when on the default branch', async () => {
    setupEmptyConcurrentCalls('# branch.head main\n# branch.ab +0 -0\n');
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })); // symbolic-ref

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.branchMerged).toBe(false);
  });

  it('handles rename paths with brace syntax in numstat', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '8\t3\tsrc/{old.ts => new.ts}\n' })) // numstat with brace rename
      .mockResolvedValueOnce(makeExecResult({ stdout: '# branch.head main\n# branch.ab +0 -0\n2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts\n' })); // porcelain (rename entry)

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({ status: 'R', filename: 'src/new.ts', additions: 8, deletions: 3 });
  });

  it('parses ahead and behind counts from porcelain', async () => {
    setupEmptyConcurrentCalls('# branch.head feature\n# branch.ab +5 -2\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })) // symbolic-ref
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // fetch
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: '5\n' })); // rev-list

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.ahead).toBe(5);
    expect(data.behind).toBe(2);
  });

  it('openPrUrl is set when gh pr list returns an open PR (ahead > 0 branch)', async () => {
    setupEmptyConcurrentCalls('# branch.head feature/my-feature\n# branch.ab +1 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })) // symbolic-ref
      // ahead=1 → no fetch/rev-list, next call is gh pr list
      .mockResolvedValueOnce(makeExecResult({
        stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/42' }]),
      }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.openPrUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  it('openPrUrl is null when gh pr list returns an empty array', async () => {
    setupEmptyConcurrentCalls('# branch.head feature/my-feature\n# branch.ab +1 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })) // symbolic-ref
      .mockResolvedValueOnce(makeExecResult({ stdout: '[]' })); // gh pr list: no open PRs

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.openPrUrl).toBeNull();
  });

  it('openPrUrl is null and response succeeds when gh pr list throws', async () => {
    setupEmptyConcurrentCalls('# branch.head feature/my-feature\n# branch.ab +1 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })) // symbolic-ref
      .mockRejectedValueOnce(new Error('gh: command not found')); // gh pr list throws

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.openPrUrl).toBeNull();
  });

  it('openPrUrl is set on ahead=0 branch with open PR (after merge check)', async () => {
    setupEmptyConcurrentCalls('# branch.head feature/my-feature\n# branch.ab +0 -0\n');
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })) // symbolic-ref
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0 })) // fetch
      .mockResolvedValueOnce(makeExecResult({ exitCode: 0, stdout: '2\n' })) // rev-list: 2 ahead of origin → not merged
      .mockResolvedValueOnce(makeExecResult({ // gh pr list
        stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/5' }]),
      }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.openPrUrl).toBe('https://github.com/owner/repo/pull/5');
    expect(data.branchMerged).toBe(false);
  });

  it('openPrUrl is not checked on the default branch', async () => {
    setupEmptyConcurrentCalls('# branch.head main\n# branch.ab +0 -0\n');
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'refs/remotes/origin/main\n' })); // symbolic-ref

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.openPrUrl).toBeNull();
    // gh pr list should never have been called — only symbolic-ref after the two
    // parallel setup calls (numstat + porcelain). Call count: 2 + 1 = 3.
    expect(execMock).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/projects/by-project/[projectName]/changes', () => {
  let POST: typeof import('@/app/api/projects/by-project/[projectName]/changes/route').POST;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(makeExecResult({ stdout: '' }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/changes/route');
    POST = mod.POST;
  });

  afterEach(() => { vi.resetModules(); });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('runs git pull --ff-only by default', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'Already up to date.' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.output).toBe('Already up to date.');
    expect(execMock).toHaveBeenNthCalledWith(1, 'git', ['-C', '/path/to/proj', 'status', '--porcelain'], { timeout: 5000 });
    expect(execMock).toHaveBeenCalledWith('git', ['-C', '/path/to/proj', 'pull', '--ff-only'], { timeout: 30000 });
  });

  it('runs git pull --no-ff when strategy is merge', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'Already up to date.' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', {
      method: 'POST',
      body: JSON.stringify({ strategy: 'merge' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    expect(execMock).toHaveBeenCalledWith('git', ['-C', '/path/to/proj', 'pull', '--no-ff'], { timeout: 30000 });
  });

  it('runs git pull --rebase when strategy is rebase', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: 'Already up to date.' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', {
      method: 'POST',
      body: JSON.stringify({ strategy: 'rebase' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    expect(execMock).toHaveBeenCalledWith('git', ['-C', '/path/to/proj', 'pull', '--rebase'], { timeout: 30000 });
  });

  it('rejects unknown pull strategies with 400 (regression: silently fell through to ff-only)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', {
      method: 'POST',
      body: JSON.stringify({ strategy: 'force-overwrite' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toMatch(/strategy must be one of/i);
    // Crucially: no git invocations should have fired before the 400.
    expect(execMock).not.toHaveBeenCalled();
  });

  it('returns 409 with diverged flag when branches cannot fast-forward', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'Not possible to fast-forward, aborting.' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.diverged).toBe(true);
  });

  it('returns 409 when stderr contains "diverged"', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'Your branch and origin/main have diverged.' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(409);
  });

  it('returns 422 for non-diverged pull failure', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({ exitCode: 1, stderr: 'Connection refused to remote.' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toBe('Connection refused to remote.');
  });

  it('strips hint: lines from error before returning 422', async () => {
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: '' }))
      .mockResolvedValueOnce(makeExecResult({
        exitCode: 1,
        stderr: 'error: failed to push some refs\nhint: Updates were rejected\nhint: because the tip is behind',
      }));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toBe('error: failed to push some refs');
    expect(data.detail).not.toContain('hint:');
  });

  it('returns 409 before pulling when the working tree has tracked changes', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: ' M src/app.ts\n' }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('Working tree has local changes');
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('returns 409 before pulling when the working tree has untracked files', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: '?? notes.txt\n' }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/changes', { method: 'POST', body: '{}' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('Working tree has local changes');
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});

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
