import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The handler shells out to git + gh and dispatches pr-wait. We stub the shell
// and pr-wait launcher so the test is hermetic, then assert the safety-critical
// behavior: a rebase conflict aborts cleanly and NEVER force-pushes, while a
// clean rebase force-pushes and resumes pr-wait.

interface GitResp { exitCode: number; stdout: string; stderr?: string }

function key(cmd: string, args: string[]): string {
  const trimmed = args[0] === '-C' ? args.slice(2) : args;
  return `${cmd} ${trimmed.join(' ')}`;
}

function setup(responses: Record<string, GitResp>, launchResult: { jobId: string } | { error: string }) {
  const calls: string[] = [];
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    const k = key(cmd, args);
    calls.push(k);
    for (const [pat, resp] of Object.entries(responses)) {
      if (k.startsWith(pat)) return resp;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const launchPrWait = vi.fn(() => launchResult);
  vi.doMock('@/lib/shared/shell', () => ({ exec }));
  vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ launchPrWait }));
  return { exec, launchPrWait, calls };
}

const candidate = { project: 'proj', path: '/tmp/proj', branch: 'fix/issue-1-x', defaultBranch: 'main' };

const prJson = JSON.stringify({
  number: 200,
  url: 'https://github.com/o/r/pull/200',
  state: 'OPEN',
  headRefName: 'fix/issue-1-x',
  headRepository: { name: 'r' },
  headRepositoryOwner: { login: 'o' },
});

const mergedPrJson = JSON.stringify({
  number: 200,
  url: 'https://github.com/o/r/pull/200',
  state: 'MERGED',
  headRefName: 'fix/issue-1-x',
  headRepository: { name: 'r' },
  headRepositoryOwner: { login: 'o' },
});

function validPreflight(overrides: Record<string, GitResp> = {}): Record<string, GitResp> {
  return {
    'git fetch': { exitCode: 0, stdout: '' },
    'git branch --show-current': { exitCode: 0, stdout: 'fix/issue-1-x' },
    'git status --porcelain': { exitCode: 0, stdout: '' },
    'git rev-list --count @{u}..HEAD': { exitCode: 0, stdout: '0' },
    'git rev-list --count HEAD..origin/main': { exitCode: 0, stdout: '8' },
    'gh pr view': { exitCode: 0, stdout: prJson },
    ...overrides,
  };
}

describe('rebasePrBehindBranch', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('aborts (never force-pushing) and dispatches a pr-wait to surface the conflict as a HITL', async () => {
    const { calls, launchPrWait } = setup(
      validPreflight({
        'git rebase origin/main': { exitCode: 1, stdout: 'CONFLICT (content): Merge conflict in lib/x.ts', stderr: '' },
        'git rebase --abort': { exitCode: 0, stdout: '' },
      }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    // Never a silent stop: the unresolved conflict is handed to a pr-wait, which
    // observes mergeable=CONFLICTING and finalizes 'conflict' → a
    // pr_needs_manual_merge HITL in the inbox.
    expect(r.outcome).toBe('started');
    expect(r.detail).toMatch(/conflict/i);
    expect(launchPrWait).toHaveBeenCalledWith('proj', 200, 'o/r', 'https://github.com/o/r/pull/200');
    expect(calls).toContain('git rebase --abort');
    // Critical safety property: never force-push a half-resolved merge.
    expect(calls.some((c) => c.includes('push') && c.includes('--force-with-lease'))).toBe(false);
  });

  it('rebases, force-pushes and resumes pr-wait on a clean rebase', async () => {
    const { calls, launchPrWait } = setup(
      validPreflight({
        'git rebase origin/main': { exitCode: 0, stdout: 'Successfully rebased' },
        'git push --force-with-lease': { exitCode: 0, stdout: '' },
      }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    expect(r.outcome).toBe('started');
    expect(calls.some((c) => c.includes('push') && c.includes('--force-with-lease'))).toBe(true);
    expect(launchPrWait).toHaveBeenCalledWith('proj', 200, 'o/r', 'https://github.com/o/r/pull/200');
  });

  it('reports rejected when the force-push fails', async () => {
    const { calls } = setup(
      validPreflight({
        'git rebase origin/main': { exitCode: 0, stdout: 'Successfully rebased' },
        'git push --force-with-lease': { exitCode: 1, stdout: '', stderr: 'stale info' },
      }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/force-push/i);
    expect(calls.some((c) => c.startsWith('gh pr view'))).toBe(true);
  });

  it('rejects without rebasing or force-pushing when the branch changed after scan', async () => {
    const { calls } = setup(
      validPreflight({
        'git branch --show-current': { exitCode: 0, stdout: 'main' },
      }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/branch changed/i);
    expect(calls.some((c) => c.startsWith('git rebase'))).toBe(false);
    expect(calls.some((c) => c.includes('push') && c.includes('--force-with-lease'))).toBe(false);
  });

  it('rejects without rebasing or force-pushing when the worktree became dirty after scan', async () => {
    const { calls } = setup(
      validPreflight({
        'git status --porcelain': { exitCode: 0, stdout: ' M lib/x.ts' },
      }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/worktree changed/i);
    expect(calls.some((c) => c.startsWith('git rebase'))).toBe(false);
    expect(calls.some((c) => c.includes('push') && c.includes('--force-with-lease'))).toBe(false);
  });

  it('rejects without rebasing or force-pushing when the branch is no longer behind', async () => {
    const { calls } = setup(
      validPreflight({
        'git rev-list --count HEAD..origin/main': { exitCode: 0, stdout: '0' },
      }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/no longer behind/i);
    expect(calls.some((c) => c.startsWith('git rebase'))).toBe(false);
    expect(calls.some((c) => c.includes('push') && c.includes('--force-with-lease'))).toBe(false);
  });

  it('rejects without rebasing or force-pushing when no open PR exists for the branch', async () => {
    const { calls, launchPrWait } = setup(
      validPreflight({
        'gh pr view': { exitCode: 1, stdout: '', stderr: 'no pull requests found' },
      }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/no open PR/i);
    expect(calls.some((c) => c.startsWith('git rebase'))).toBe(false);
    expect(calls.some((c) => c.includes('push') && c.includes('--force-with-lease'))).toBe(false);
    expect(launchPrWait).not.toHaveBeenCalled();
  });

  it('treats a MERGED PR on a reused branch as "no open PR" and never mutates the repo', async () => {
    // The branch name was reused after an earlier PR merged. `gh pr view`
    // returns that MERGED PR; resuming it would falsely report a ship.
    const { calls, launchPrWait } = setup(
      validPreflight({ 'gh pr view': { exitCode: 0, stdout: mergedPrJson } }),
      { jobId: 'pw1' },
    );
    const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await rebasePrBehindBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/no open PR/i);
    expect(calls.some((c) => c.startsWith('git rebase'))).toBe(false);
    expect(calls.some((c) => c.includes('push') && c.includes('--force-with-lease'))).toBe(false);
    expect(launchPrWait).not.toHaveBeenCalled();
  });
});

describe('resumePrWaitForBranch', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('resumes pr-wait for an up-to-date clean open-PR branch without rebasing or pushing', async () => {
    const { calls, launchPrWait } = setup(
      validPreflight({ 'git rev-list --count HEAD..origin/main': { exitCode: 0, stdout: '0' } }),
      { jobId: 'pw1' },
    );
    const { resumePrWaitForBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await resumePrWaitForBranch(candidate);

    expect(r.outcome).toBe('started');
    expect(launchPrWait).toHaveBeenCalledWith('proj', 200, 'o/r', 'https://github.com/o/r/pull/200');
    // No repo mutation — it is already mergeable.
    expect(calls.some((c) => c.startsWith('git rebase'))).toBe(false);
    expect(calls.some((c) => c.includes('push'))).toBe(false);
  });

  it('defers to the rebase path when the branch fell behind after the scan', async () => {
    const { launchPrWait } = setup(
      validPreflight({ 'git rev-list --count HEAD..origin/main': { exitCode: 0, stdout: '3' } }),
      { jobId: 'pw1' },
    );
    const { resumePrWaitForBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await resumePrWaitForBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/behind/i);
    expect(launchPrWait).not.toHaveBeenCalled();
  });

  it('does not resume a MERGED PR on a reused branch', async () => {
    const { launchPrWait } = setup(
      validPreflight({
        'git rev-list --count HEAD..origin/main': { exitCode: 0, stdout: '0' },
        'gh pr view': { exitCode: 0, stdout: mergedPrJson },
      }),
      { jobId: 'pw1' },
    );
    const { resumePrWaitForBranch } = await import('@/lib/jobs/pr-behind-rebase');
    const r = await resumePrWaitForBranch(candidate);

    expect(r.outcome).toBe('rejected');
    expect(r.detail).toMatch(/no open PR/i);
    expect(launchPrWait).not.toHaveBeenCalled();
  });
});
