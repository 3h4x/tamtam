import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('createGenericPR', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let createGenericPR: typeof import('@/lib/pipeline/pr-create').createGenericPR;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: vi.fn(() => []) }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      detectMainBranch: vi.fn().mockResolvedValue('main'),
      issueBranchName: vi.fn(),
    }));
    ({ createGenericPR } = await import('@/lib/pipeline/pr-create'));
  });
  afterEach(() => vi.resetModules());

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  const logs: string[] = [];
  const log = (s: string) => logs.push(s);

  beforeEach(() => logs.splice(0));

  it('returns false when already on the default branch', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'main\n'))   // git branch --show-current
    const result = await createGenericPR('/repo', log);
    expect(result).toBe(false);
  });

  it('returns false when branch is empty string', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, '\n'))         // git branch --show-current → empty
    const result = await createGenericPR('/repo', log);
    expect(result).toBe(false);
  });

  it('returns existing PR url and repo when a PR already exists', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'feat/my-feature\n'))              // git branch --show-current
      .mockResolvedValueOnce(resp(0, JSON.stringify({ url: 'https://github.com/org/repo/pull/5' })))  // gh pr view
      .mockResolvedValueOnce(resp(0, 'org/repo\n'));                    // gh repo view

    const result = await createGenericPR('/repo', log);
    expect(result).toEqual({ prUrl: 'https://github.com/org/repo/pull/5', prRepo: 'org/repo' });
  });

  it('creates a new PR when none exists and returns url + repo', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'feat/cool-feature\n'))            // git branch --show-current
      .mockResolvedValueOnce(resp(1, ''))                               // gh pr view → no PR
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/9\n'))  // gh pr create
      .mockResolvedValueOnce(resp(0, 'org/repo\n'));                    // gh repo view

    const result = await createGenericPR('/repo', log);
    expect(result).toEqual({ prUrl: 'https://github.com/org/repo/pull/9', prRepo: 'org/repo' });
  });

  it('returns null when gh pr create fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'feat/bugfix\n'))                  // git branch --show-current
      .mockResolvedValueOnce(resp(1, ''))                               // gh pr view → no PR
      .mockResolvedValueOnce(resp(1, '', 'already exists'));             // gh pr create fails

    const result = await createGenericPR('/repo', log);
    expect(result).toBeNull();
  });

  it('returns null when pr create stdout is empty', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'feat/bugfix\n'))
      .mockResolvedValueOnce(resp(1, ''))                               // no existing PR
      .mockResolvedValueOnce(resp(0, ''));                              // gh pr create → empty stdout

    const result = await createGenericPR('/repo', log);
    expect(result).toBeNull();
  });

  it('returns null when gh pr create returns no shell result', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'feat/bugfix\n'))
      .mockResolvedValueOnce(resp(1, ''))
      .mockResolvedValueOnce(undefined);

    const result = await createGenericPR('/repo', log);
    expect(result).toBeNull();
  });
});

describe('createIssuePR', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let createIssuePR: typeof import('@/lib/pipeline/pr-create').createIssuePR;

  const issue = { number: 42, repo: 'org/repo', title: 'Fix login bug' };

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    listJobsMock = vi.fn(() => []);
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: listJobsMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      detectMainBranch: vi.fn().mockResolvedValue('main'),
      issueBranchName: vi.fn().mockReturnValue('fix/issue-42-fix-login-bug'),
    }));
    ({ createIssuePR } = await import('@/lib/pipeline/pr-create'));
  });
  afterEach(() => vi.resetModules());

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  const logs: string[] = [];
  const log = (s: string) => logs.push(s);

  beforeEach(() => logs.splice(0));

  it('returns existing PR url when a PR already exists on feature branch', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))   // git branch --show-current
      .mockResolvedValueOnce(resp(0, JSON.stringify([{ url: 'https://github.com/org/repo/pull/11' }])))  // gh pr list
    const result = await createIssuePR('/repo', log, issue);
    expect(result).toBe('https://github.com/org/repo/pull/11');
  });

  it('creates a PR when on feature branch and none exists', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))   // git branch --show-current
      .mockResolvedValueOnce(resp(0, '[]'))                              // gh pr list → empty
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));  // gh pr create

    const result = await createIssuePR('/repo', log, issue);
    expect(result).toBe('https://github.com/org/repo/pull/13');
  });

  it('prepends "fix: " to issue title when title lacks a conventional commit prefix', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue);

    const prCreateCall = execMock.mock.calls.find(
      (c: any[]) => c[0] === 'gh' && c[1]?.includes('create')
    );
    expect(prCreateCall).toBeTruthy();
    const titleIdx = (prCreateCall![1] as string[]).indexOf('--title');
    expect((prCreateCall![1] as string[])[titleIdx + 1]).toBe('fix: Fix login bug');
  });

  it('uses title as-is when it already has a conventional commit prefix', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-99-fix-auth\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/20\n'));

    await createIssuePR('/repo', log, { number: 99, repo: 'org/repo', title: 'feat: Add OAuth support' });

    const prCreateCall = execMock.mock.calls.find(
      (c: any[]) => c[0] === 'gh' && c[1]?.includes('create')
    );
    const titleIdx = (prCreateCall![1] as string[]).indexOf('--title');
    expect((prCreateCall![1] as string[])[titleIdx + 1]).toBe('feat: Add OAuth support');
  });

  it('creates a feature branch and pushes when on default branch', async () => {
    const controller = new AbortController();
    execMock
      .mockResolvedValueOnce(resp(0, 'main\n'))               // git branch --show-current → default
      .mockResolvedValueOnce(resp(0, ''))                     // git branch <feature>
      .mockResolvedValueOnce(resp(0, ''))                     // git push -u origin
      .mockResolvedValueOnce(resp(0, '[]'))                   // gh pr list → no existing PR
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/7\n')); // gh pr create

    const result = await createIssuePR('/repo', log, issue, controller.signal);
    expect(result).toBe('https://github.com/org/repo/pull/7');

    const branchPushCall = execMock.mock.calls.find(
      (c: any[]) => c[0] === 'git' && c[1]?.includes('push')
    );
    expect(branchPushCall).toBeTruthy();
    expect(branchPushCall?.[2]).toMatchObject({
      timeout: 30000,
      signal: controller.signal,
      abortProcessTree: true,
    });

    const prListCall = execMock.mock.calls.find(
      (c: any[]) => c[0] === 'gh' && c[1]?.includes('list')
    );
    expect(prListCall).toBeTruthy();
    const headIdx = (prListCall![1] as string[]).indexOf('--head');
    expect((prListCall![1] as string[])[headIdx + 1]).toBe('fix/issue-42-fix-login-bug');
  });

  it('returns null when branch push fails on default branch', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'main\n'))               // git branch --show-current → default
      .mockResolvedValueOnce(resp(0, ''))                     // git branch <feature>
      .mockResolvedValueOnce(resp(1, '', 'push rejected'));   // git push fails

    const result = await createIssuePR('/repo', log, issue);
    expect(result).toBeNull();
  });

  it('returns null when gh pr create fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(1, '', 'creation failed'));

    const result = await createIssuePR('/repo', log, issue);
    expect(result).toBeNull();
  });

  it('returns null when branch push returns no shell result', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'main\n'))
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(undefined);

    const result = await createIssuePR('/repo', log, issue);
    expect(result).toBeNull();
  });

  function getCreatedBody() {
    const prCreateCall = execMock.mock.calls.find(
      (c: any[]) => c[0] === 'gh' && c[1]?.includes('create')
    );
    expect(prCreateCall).toBeTruthy();
    const args = prCreateCall![1] as string[];
    const bodyIdx = args.indexOf('--body');
    return args[bodyIdx + 1];
  }

  it('falls back to stub body when no run job is stamped for the issue', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue);

    expect(getCreatedBody()).toBe(
      `Closes #42\n\nImplemented via TamTam from issue [#42](https://github.com/org/repo/issues/42).`,
    );
  });

  it('renders the run summary in the PR body when a recent run job carries report data', async () => {
    listJobsMock.mockReturnValue([
      {
        id: 'job-1',
        kind: 'run',
        project: 'proj-a',
        ghIssueNumber: 42,
        ghIssueRepo: 'org/repo',
        startedAt: 1000,
        workSummary: 'Wired DAO revenue to real gateway data and added tests.',
        modifiedFiles: JSON.stringify([
          { path: 'src/app/dao/revenue/page.tsx', status: 'M' },
        ]),
      },
    ]);
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'proj-a');

    const body = getCreatedBody();
    expect(body).toContain('Closes #42');
    expect(body).toContain('Wired DAO revenue to real gateway data');
    expect(body).not.toContain('## Files changed');
    expect(body).not.toContain('src/app/dao/revenue/page.tsx');
    expect(body).toContain('Implemented via TamTam from issue [#42]');
  });

  it('picks the most recent matching run job when several are stamped', async () => {
    listJobsMock.mockReturnValue([
      {
        id: 'old',
        kind: 'run',
        project: 'proj-a',
        ghIssueNumber: 42,
        ghIssueRepo: 'org/repo',
        startedAt: 100,
        workSummary: 'Old summary.',
        modifiedFiles: '[]',
      },
      {
        id: 'newer',
        kind: 'run',
        project: 'proj-a',
        ghIssueNumber: 42,
        ghIssueRepo: 'org/repo',
        startedAt: 9000,
        workSummary: 'Newer summary.',
        modifiedFiles: '[]',
      },
    ]);
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'proj-a');

    const body = getCreatedBody();
    expect(body).toContain('Newer summary.');
    expect(body).not.toContain('Old summary.');
  });

  it('ignores newer stamped run jobs from other projects', async () => {
    listJobsMock.mockReturnValue([
      {
        id: 'other-project-newer',
        kind: 'run',
        project: 'proj-b',
        ghIssueNumber: 42,
        ghIssueRepo: 'org/repo',
        startedAt: 9000,
        workSummary: 'Wrong project summary.',
        modifiedFiles: JSON.stringify([{ path: 'src/wrong-project.ts', status: 'M' }]),
      },
      {
        id: 'current-project-older',
        kind: 'run',
        project: 'proj-a',
        ghIssueNumber: 42,
        ghIssueRepo: 'org/repo',
        startedAt: 1000,
        workSummary: 'Current project summary.',
        modifiedFiles: JSON.stringify([{ path: 'src/current-project.ts', status: 'M' }]),
      },
    ]);
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'proj-a');

    const body = getCreatedBody();
    expect(body).toContain('Current project summary.');
    expect(body).not.toContain('Wrong project summary.');
  });

  it('falls back to the stub body when only another project has stamped run data', async () => {
    listJobsMock.mockReturnValue([
      {
        id: 'other-project-only',
        kind: 'run',
        project: 'proj-b',
        ghIssueNumber: 42,
        ghIssueRepo: 'org/repo',
        startedAt: 9000,
        workSummary: 'Wrong project summary.',
        modifiedFiles: JSON.stringify([{ path: 'src/wrong-project.ts', status: 'M' }]),
      },
    ]);
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'proj-a');

    expect(getCreatedBody()).toBe(
      `Closes #42\n\nImplemented via TamTam from issue [#42](https://github.com/org/repo/issues/42).`,
    );
  });
});
