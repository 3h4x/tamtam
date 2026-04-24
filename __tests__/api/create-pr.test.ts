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
    // Default to a safe no-op exec result so tests only have to mock the
    // calls they care about. The route calls `exec` many times (branch lookup,
    // git-log scans for conventional-commit type detection, gh issue view,
    // git-log for PR body) and chaining `.mockResolvedValueOnce` for each one
    // in every test is both brittle and uninformative.
    execMock = vi.fn().mockResolvedValue(makeExecResult());
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
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('branch') && args.includes('--show-current')) {
        return makeExecResult({ stdout: 'feat/my-branch\n' });
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return makeExecResult({ exitCode: 1, stderr: 'gh: not authenticated' });
      }
      return makeExecResult();
    });
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('gh: not authenticated');
  });

  // Dispatch mock keyed by command — the route makes many git/gh calls to
  // derive a conventional-commits-flavored title; tests only care about
  // `branch --show-current` and `gh pr create`. Other calls fall through to
  // the default empty result.
  function mockByCmd(handlers: { branch?: string; ghCreate?: ReturnType<typeof makeExecResult> }) {
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('branch') && args.includes('--show-current')) {
        return makeExecResult({ stdout: handlers.branch ?? '' });
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return handlers.ghCreate ?? makeExecResult();
      }
      return makeExecResult();
    });
  }

  it('extracts the PR URL from gh output and returns it', async () => {
    mockByCmd({
      branch: 'feat/my-branch\n',
      ghCreate: makeExecResult({
        stdout: 'Creating pull request for feat/my-branch into main in owner/repo\n\nhttps://github.com/owner/repo/pull/42\n',
      }),
    });
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe('https://github.com/owner/repo/pull/42');
  });

  it('picks the trailing PR URL when preamble references another PR', async () => {
    mockByCmd({
      branch: 'feat/my-branch\n',
      ghCreate: makeExecResult({
        stdout: 'Refs https://github.com/owner/repo/pull/1\nhttps://github.com/owner/repo/pull/7\n',
      }),
    });
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.url).toBe('https://github.com/owner/repo/pull/7');
  });

  it('returns null url when gh output does not contain a PR link', async () => {
    mockByCmd({
      branch: 'feat/my-branch\n',
      ghCreate: makeExecResult({ stdout: 'something unexpected\n' }),
    });
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

  // Helpers for CC-title tests — dispatch by command so the exact call order
  // doesn't matter (the route makes several git/gh calls per request).
  function mockCcByCmd(handlers: {
    branch?: string;
    branchLog?: string;       // git log main..HEAD --pretty=%s
    issueTitle?: string | null; // null = fail gh issue view
    bodyLog?: string;         // git log main..HEAD --pretty=- %s
    ghCreate?: ReturnType<typeof makeExecResult>;
  }) {
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('branch') && args.includes('--show-current')) {
        return makeExecResult({ stdout: (handlers.branch ?? 'feat/my-feature') + '\n' });
      }
      if (cmd === 'git' && args.includes('log') && args.includes('--pretty=%s')) {
        return makeExecResult({ stdout: handlers.branchLog ?? '' });
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        if (handlers.issueTitle === null) return makeExecResult({ exitCode: 1 });
        return makeExecResult({ stdout: JSON.stringify({ title: handlers.issueTitle ?? '' }) });
      }
      if (cmd === 'git' && args.includes('log') && args.includes('--pretty=- %s')) {
        return makeExecResult({ stdout: handlers.bodyLog ?? '- some commit' });
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return handlers.ghCreate ?? makeExecResult({ stdout: 'https://github.com/o/r/pull/1\n' });
      }
      return makeExecResult();
    });
  }

  it('derives CC title from issue title for fix/issue-N-slug branches', async () => {
    mockCcByCmd({
      branch: 'fix/issue-9-track-keyword-rank',
      branchLog: 'feat: add rank tracking\n',
      issueTitle: 'Track keyword rank history so you can see trends',
      ghCreate: makeExecResult({ stdout: 'https://github.com/o/r/pull/9\n' }),
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const ghCreate = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'create');
    expect(ghCreate).toBeTruthy();
    const createArgs: string[] = ghCreate![1];
    expect(createArgs).toContain('--title');
    const title = createArgs[createArgs.indexOf('--title') + 1];
    // type comes from branch commits (feat), summary comes from issue title
    expect(title).toBe('feat: track keyword rank history so you can see trends');
  });

  it('includes Closes #N in PR body for issue-linked branches', async () => {
    mockCcByCmd({
      branch: 'fix/issue-9-track-keyword-rank',
      branchLog: 'fix: correct ranking\n',
      issueTitle: 'Track keyword rank',
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const ghCreate = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'create');
    const createArgs: string[] = ghCreate![1];
    expect(createArgs).toContain('--body');
    const body = createArgs[createArgs.indexOf('--body') + 1];
    expect(body).toContain('Closes #9');
  });

  it('falls back to commit subject when not on an issue branch', async () => {
    mockCcByCmd({
      branch: 'feat/add-search',
      branchLog: 'feat: add full-text search\nchore: update deps\n',
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const ghCreate = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'create');
    const createArgs: string[] = ghCreate![1];
    const title = createArgs[createArgs.indexOf('--title') + 1];
    expect(title).toBe('feat: add full-text search');
  });

  it('strips existing CC prefix from commit subject to avoid double-prefixing', async () => {
    mockCcByCmd({
      branch: 'fix/my-bug',
      branchLog: 'fix(auth): correct token expiry\n',
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const ghCreate = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'create');
    const createArgs: string[] = ghCreate![1];
    const title = createArgs[createArgs.indexOf('--title') + 1];
    // type=fix (from commits), summary=stripped subject — no "fix: fix(auth):"
    expect(title).toBe('fix: correct token expiry');
  });

  it('picks highest-priority CC type across branch commits (feat > fix)', async () => {
    mockCcByCmd({
      branch: 'feat/big-feature',
      branchLog: 'chore: lint\nfix: typo\nfeat: add search\n',
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const ghCreate = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'create');
    const createArgs: string[] = ghCreate![1];
    const title = createArgs[createArgs.indexOf('--title') + 1];
    expect(title.startsWith('feat:')).toBe(true);
  });

  it('defaults to chore type when no branch commits have a CC prefix', async () => {
    mockCcByCmd({
      branch: 'my-branch',
      branchLog: 'Add something\nFix a bug\n',
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const ghCreate = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'create');
    const createArgs: string[] = ghCreate![1];
    const title = createArgs[createArgs.indexOf('--title') + 1];
    expect(title.startsWith('chore:')).toBe(true);
  });

  it('falls back to --fill when no commits and no issue title', async () => {
    mockCcByCmd({
      branch: 'my-branch',
      branchLog: '',      // no commits → no summary
      issueTitle: null,   // not an issue branch / issue fetch fails
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const ghCreate = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'create');
    const createArgs: string[] = ghCreate![1];
    expect(createArgs).toContain('--fill');
    expect(createArgs).not.toContain('--title');
  });

  it('does not call gh issue view for non-issue branches', async () => {
    mockCcByCmd({
      branch: 'feat/no-issue',
      branchLog: 'feat: add thing\n',
    });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const issueCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args[1] === 'view');
    expect(issueCall).toBeUndefined();
  });
});
