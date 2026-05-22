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

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ detectMainBranch: detectMainBranchMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ pushCurrentBranch: pushCurrentBranchMock }));

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

  it('returns 500 when git push fails for non-hook reasons (auth, network)', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'feat/my-branch\n' }));
    pushCurrentBranchMock.mockResolvedValue({ ok: false, detail: 'Push failed: auth denied', hookFailure: null });
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('Push failed');
    expect(data.detail).toContain('auth denied');
    // Non-hook failures are NOT retryable.
    expect(data.retryable).toBeUndefined();
    expect(data.hookFailure).toBeUndefined();
  });

  it('returns 409 with hookFailure: pre-push-tests when the repo pre-push hook tests fail', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-363\n' }));
    pushCurrentBranchMock.mockResolvedValue({
      ok: false,
      detail: 'Push failed: Failed Tests 1 — middleware.utils.test.ts',
      hookFailure: 'pre-push-tests',
    });
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.hookFailure).toBe('pre-push-tests');
    expect(data.retryable).toBe(true);
    expect(data.detail).toContain('Failed Tests');
  });

  it('forwards { force: true } body to pushCurrentBranch as noVerify so the hook is skipped', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-363\n' }));
    pushCurrentBranchMock.mockResolvedValue({ ok: true, commitSha: 'abc123' });
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/create-pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    // Third arg carries the noVerify option.
    expect(pushCurrentBranchMock).toHaveBeenCalledWith('/path/to/project', undefined, { noVerify: true, projectName: 'myproj' });
  });

  it('does not pass noVerify when the body is empty (default verify path)', async () => {
    execMock.mockResolvedValueOnce(makeExecResult({ stdout: 'fix/issue-363\n' }));
    pushCurrentBranchMock.mockResolvedValue({ ok: true, commitSha: 'abc123' });
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(pushCurrentBranchMock).toHaveBeenCalledWith('/path/to/project', undefined, { noVerify: false, projectName: 'myproj' });
  });

  // Dispatch mock keyed by command — the route makes many git/gh calls to
  // derive a conventional-commits-flavored title; these tests only care about
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

  it('returns 500 when gh pr create fails', async () => {
    mockByCmd({
      branch: 'feat/my-branch\n',
      ghCreate: makeExecResult({ exitCode: 1, stderr: 'gh: not authenticated' }),
    });
    const res = await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('gh: not authenticated');
  });

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

    expect(pushCurrentBranchMock).toHaveBeenCalledWith('/custom/repo', undefined, { noVerify: false, projectName: 'myproj' });
  });
});

describe('POST /api/projects/by-project/[projectName]/create-pr — title generation', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let execMock: ReturnType<typeof vi.fn>;
  let detectMainBranchMock: ReturnType<typeof vi.fn>;
  let pushCurrentBranchMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  function makeRequest() {
    return new NextRequest('http://localhost/api/projects/by-project/myproj/create-pr', { method: 'POST' });
  }

  // Dispatch exec calls by cmd+args pattern so each test only declares what it cares about.
  function buildExecDispatch(handlers: {
    branch?: string;
    logSubjects?: string;     // git log main..HEAD --pretty=%s
    issueView?: { exitCode?: number; stdout?: string }; // gh issue view
    logBullets?: string;      // git log main..HEAD --pretty=- %s (body)
    ghCreate?: { exitCode?: number; stdout?: string; stderr?: string };
  }) {
    return async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('branch') && args.includes('--show-current')) {
        return makeExecResult({ stdout: handlers.branch ?? 'feat/my-feature\n' });
      }
      if (cmd === 'git' && args.includes('log') && args.includes('--pretty=%s')) {
        return makeExecResult({ stdout: handlers.logSubjects ?? '' });
      }
      if (cmd === 'git' && args.includes('log') && args.includes('--pretty=- %s')) {
        return makeExecResult({ stdout: handlers.logBullets ?? '- some commit' });
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return makeExecResult(handlers.issueView ?? { exitCode: 1, stdout: '' });
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return makeExecResult(handlers.ghCreate ?? { stdout: 'https://github.com/o/r/pull/1\n' });
      }
      return makeExecResult();
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    detectMainBranchMock = vi.fn().mockResolvedValue('main');
    pushCurrentBranchMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc123' });

    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/repo') }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ detectMainBranch: detectMainBranchMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ pushCurrentBranch: pushCurrentBranchMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/create-pr/route');
    POST = mod.POST;
  });

  afterEach(() => { vi.resetModules(); });

  it('uses feat: type when a commit subject starts with feat:', async () => {
    execMock.mockImplementation(buildExecDispatch({
      logSubjects: 'feat: add dark mode\nfix: correct typo\n',
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    expect(prCreateCall).toBeTruthy();
    const titleIdx = prCreateCall![1].indexOf('--title');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(prCreateCall![1][titleIdx + 1]).toMatch(/^feat:/);
  });

  it('prefers feat over fix in CC priority ordering', async () => {
    execMock.mockImplementation(buildExecDispatch({
      logSubjects: 'fix: patch one\nfeat: add feature\nchore: update deps\n',
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    expect(prCreateCall![1][titleIdx + 1]).toMatch(/^feat:/);
  });

  it('defaults to chore type when no commit has a CC prefix', async () => {
    execMock.mockImplementation(buildExecDispatch({
      logSubjects: 'update readme\nadd docs\n',
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    expect(prCreateCall![1][titleIdx + 1]).toMatch(/^chore:/);
  });

  it('uses commit subject summary as PR title when branch is not an issue branch', async () => {
    execMock.mockImplementation(buildExecDispatch({
      branch: 'feat/dark-mode\n',
      logSubjects: 'feat: implement dark mode toggle\n',
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    expect(prCreateCall![1][titleIdx + 1]).toBe('feat: implement dark mode toggle');
  });

  it('strips CC prefix from commit subject to avoid double-prefixing', async () => {
    execMock.mockImplementation(buildExecDispatch({
      branch: 'feat/dark-mode\n',
      logSubjects: 'fix: correct the off-by-one error\n',
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    const title: string = prCreateCall![1][titleIdx + 1];
    // Should be "fix: correct the off-by-one error" (type detected from commit) — NOT "fix: fix: correct..."
    expect(title).not.toMatch(/^fix: fix:/);
    expect(title).toBe('fix: correct the off-by-one error');
  });

  it('fetches issue title from gh when branch matches fix/issue-N-... pattern', async () => {
    execMock.mockImplementation(buildExecDispatch({
      branch: 'fix/issue-42-add-login\n',
      logSubjects: 'fix: implement login\n',
      issueView: { exitCode: 0, stdout: JSON.stringify({ title: 'Add login page' }) },
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const issueViewCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'issue' && args[1] === 'view' && args[2] === '42',
    );
    expect(issueViewCall).toBeTruthy();
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    expect(prCreateCall![1][titleIdx + 1]).toBe('fix: add login page');
  });

  it('includes Closes #N in PR body for issue branches', async () => {
    execMock.mockImplementation(buildExecDispatch({
      branch: 'fix/issue-7-bugfix\n',
      logSubjects: 'fix: patch the bug\n',
      issueView: { exitCode: 0, stdout: JSON.stringify({ title: 'Fix the bug' }) },
      logBullets: '- fix: patch the bug',
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const bodyIdx = prCreateCall![1].indexOf('--body');
    const body: string = prCreateCall![1][bodyIdx + 1];
    expect(body).toContain('Closes #7');
    expect(body).toContain('- fix: patch the bug');
  });

  it('falls back to --fill when no commits exist and branch is not an issue branch', async () => {
    execMock.mockImplementation(buildExecDispatch({
      logSubjects: '', // no commits on branch
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    expect(prCreateCall![1]).toContain('--fill');
    expect(prCreateCall![1]).not.toContain('--title');
  });

  it('falls back to commit subject when issue view fails', async () => {
    execMock.mockImplementation(buildExecDispatch({
      branch: 'fix/issue-99-broken-thing\n',
      logSubjects: 'fix: repair broken thing\n',
      issueView: { exitCode: 1, stdout: '' }, // gh issue view fails
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    expect(prCreateCall![1][titleIdx + 1]).toBe('fix: repair broken thing');
    // Body should NOT have Closes # since we couldn't confirm the issue
    const bodyIdx = prCreateCall![1].indexOf('--body');
    expect(prCreateCall![1][bodyIdx + 1]).not.toContain('Closes');
  });

  it('strips CC prefix from issue title to avoid double-prefixing', async () => {
    execMock.mockImplementation(buildExecDispatch({
      branch: 'fix/issue-5-auth-fix\n',
      logSubjects: 'fix: correct auth token\n',
      issueView: { exitCode: 0, stdout: JSON.stringify({ title: 'fix: Correct auth token expiry' }) },
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    const title: string = prCreateCall![1][titleIdx + 1];
    expect(title).not.toMatch(/^fix: fix:/i);
    expect(title).toBe('fix: correct auth token expiry');
  });

  it('lowercases first char of issue title used as summary', async () => {
    execMock.mockImplementation(buildExecDispatch({
      branch: 'fix/issue-3-something\n',
      logSubjects: 'feat: do something\n',
      issueView: { exitCode: 0, stdout: JSON.stringify({ title: 'Capitalised issue title' }) },
    }));
    await POST(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    const prCreateCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
    );
    const titleIdx = prCreateCall![1].indexOf('--title');
    expect(prCreateCall![1][titleIdx + 1]).toBe('feat: capitalised issue title');
  });
});
