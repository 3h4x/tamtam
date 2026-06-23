import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('createGenericPR', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let createGenericPR: typeof import('@/lib/pipeline/pr-create').createGenericPR;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ getJob: vi.fn(() => null) }));
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

  it('returns existing PR url and repo when an OPEN PR already exists', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, 'feat/my-feature\n'))              // git branch --show-current
      .mockResolvedValueOnce(resp(0, JSON.stringify({ url: 'https://github.com/org/repo/pull/5', state: 'OPEN' })))  // gh pr view
      .mockResolvedValueOnce(resp(0, 'org/repo\n'));                    // gh repo view

    const result = await createGenericPR('/repo', log);
    expect(result).toEqual({ prUrl: 'https://github.com/org/repo/pull/5', prRepo: 'org/repo' });
  });

  it('creates a new PR when the branch\'s existing PR is MERGED (reused branch name)', async () => {
    // A reused `fix/issue-*` branch whose earlier PR merged: `gh pr view`
    // returns that MERGED PR. Reusing it would make pr-wait falsely report the
    // release shipped, so createGenericPR must open a fresh PR instead.
    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-1-reused\n'))           // git branch --show-current
      .mockResolvedValueOnce(resp(0, JSON.stringify({ url: 'https://github.com/org/repo/pull/5', state: 'MERGED' })))  // gh pr view → merged
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/12\n'))  // gh pr create
      .mockResolvedValueOnce(resp(0, 'org/repo\n'));                    // gh repo view

    const result = await createGenericPR('/repo', log);
    expect(result).toEqual({ prUrl: 'https://github.com/org/repo/pull/12', prRepo: 'org/repo' });
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
  let getJobMock: ReturnType<typeof vi.fn>;
  let createIssuePR: typeof import('@/lib/pipeline/pr-create').createIssuePR;

  const issue = { number: 42, repo: 'org/repo', title: 'Fix login bug' };

  // Helper: build a parent chain {id -> job} for getJobMock to walk.
  function chain(...jobs: Array<Partial<import('@/lib/jobs/types').JobData> & { id: string }>): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const j of jobs) m.set(j.id, j);
    return m;
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    getJobMock = vi.fn(() => null);
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ getJob: getJobMock }));
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

  it('walks the parent chain to find the originating agent run and uses its summary', async () => {
    // Chain: push -> commit -> review -> test -> release -> agent:issue-cruncher
    const jobs = chain(
      { id: 'push-1', kind: 'push', parentJobId: 'commit-1', project: 'proj-a' },
      { id: 'commit-1', kind: 'commit', parentJobId: 'review-1', project: 'proj-a' },
      { id: 'review-1', kind: 'review', parentJobId: 'test-1', project: 'proj-a' },
      { id: 'test-1', kind: 'test', parentJobId: 'release-1', project: 'proj-a' },
      { id: 'release-1', kind: 'release', parentJobId: 'cruncher-1', project: 'proj-a' },
      {
        id: 'cruncher-1',
        kind: 'agent:issue-cruncher',
        project: 'proj-a',
        ghIssueNumber: 42,
        workSummary: 'Wired DAO revenue to real gateway data and added tests.',
        parentJobId: null,
      },
    );
    getJobMock.mockImplementation((id: string) => jobs.get(id) ?? null);

    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'push-1');

    const body = getCreatedBody();
    expect(body).toContain('Closes #42');
    expect(body).toContain('Wired DAO revenue to real gateway data');
    expect(body).not.toContain('## Files changed');
    expect(body).toContain('Implemented via TamTam from issue [#42]');
  });

  it('falls back to stub body when the parent chain has no eligible originating run', async () => {
    // Chain leads to a release with no parent agent run.
    const jobs = chain(
      { id: 'push-1', kind: 'push', parentJobId: 'release-1', project: 'proj-a' },
      { id: 'release-1', kind: 'release', parentJobId: null, project: 'proj-a' },
    );
    getJobMock.mockImplementation((id: string) => jobs.get(id) ?? null);

    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'push-1');

    expect(getCreatedBody()).toBe(
      `Closes #42\n\nImplemented via TamTam from issue [#42](https://github.com/org/repo/issues/42).`,
    );
  });

  it('does not pick up an unrelated agent run not in the parent chain', async () => {
    // The originating run does NOT have an agent ancestor — chain ends at release.
    // An unrelated agent:issue-cruncher with the same issue number exists in
    // the system, but since it's not on the parent chain, we must not use it.
    const jobs = chain(
      { id: 'push-1', kind: 'push', parentJobId: 'release-1', project: 'proj-a' },
      { id: 'release-1', kind: 'release', parentJobId: null, project: 'proj-a' },
    );
    getJobMock.mockImplementation((id: string) => jobs.get(id) ?? null);

    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'push-1');

    const body = getCreatedBody();
    expect(body).not.toContain('Wrong agent summary');
    expect(body).toBe(
      `Closes #42\n\nImplemented via TamTam from issue [#42](https://github.com/org/repo/issues/42).`,
    );
  });

  it('breaks parent-chain walk on cycles without recursing forever', async () => {
    // Pathological self-reference: push -> push.
    const jobs = chain(
      { id: 'push-1', kind: 'push', parentJobId: 'push-1', project: 'proj-a' },
    );
    getJobMock.mockImplementation((id: string) => jobs.get(id) ?? null);

    execMock
      .mockResolvedValueOnce(resp(0, 'fix/issue-42-fix-login-bug\n'))
      .mockResolvedValueOnce(resp(0, '[]'))
      .mockResolvedValueOnce(resp(0, 'https://github.com/org/repo/pull/13\n'));

    await createIssuePR('/repo', log, issue, undefined, 'push-1');

    expect(getCreatedBody()).toContain('Closes #42');
  });
});
