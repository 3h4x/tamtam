import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  // 1ms poll interval so the in-loop sleeps don't slow the suite.
  process.env.TAMTAM_SOAK_POLL_MS = '1';
});

const mocks = vi.hoisted(() => ({
  execMock: vi.fn(),
}));

vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));

describe('start-soak — pure helpers', () => {
  beforeEach(() => {
    mocks.execMock.mockReset();
  });

  it('classifies CI as `none` when the run list is empty', async () => {
    const { classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    expect(classifyDefaultBranchCi([])).toEqual({ kind: 'none' });
  });

  it('classifies CI as `pass` when every run completed successfully', async () => {
    const { classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const v = classifyDefaultBranchCi([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
    ]);
    expect(v).toEqual({ kind: 'pass' });
  });

  it('classifies CI as `pending` when at least one run is still running', async () => {
    const { classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const v = classifyDefaultBranchCi([
      { status: 'completed', conclusion: 'success' },
      { status: 'in_progress', conclusion: null },
    ]);
    expect(v).toEqual({ kind: 'pending' });
  });

  it('classifies CI as `fail` when any completed run failed', async () => {
    const { classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const v = classifyDefaultBranchCi([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure', workflowName: 'tests' },
    ]);
    expect(v.kind).toBe('fail');
    if (v.kind === 'fail') {
      expect(v.failed.map((r) => r.workflowName)).toEqual(['tests']);
    }
  });

  it('produces a deterministic, short revert branch name', async () => {
    const { revertBranchName } = await import('@/lib/pipeline/start-soak');
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(revertBranchName(sha)).toBe('revert/0123456789ab');
    // Same sha → same branch (idempotent across soak retries).
    expect(revertBranchName(sha)).toBe(revertBranchName(sha));
  });

  it('builds a revert PR body that mentions the merge sha + failed workflows', async () => {
    const { buildRevertPrBody } = await import('@/lib/pipeline/start-soak');
    const body = buildRevertPrBody(
      {
        mergeSha: 'deadbeef',
        prRepo: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        defaultBranch: 'main',
        watchMinutes: 20,
        autoRevert: false,
      },
      [
        { status: 'completed', conclusion: 'failure', workflowName: 'tests', url: 'https://gha/1' },
      ],
    );
    expect(body).toContain('deadbeef');
    expect(body).toContain('tests');
    expect(body).toContain('https://gha/1');
    expect(body).toContain('20 minute');
    expect(body).toContain('https://github.com/owner/repo/pull/42');
  });
});

describe('start-soak — queryDefaultBranchCi', () => {
  beforeEach(() => {
    mocks.execMock.mockReset();
  });

  it('returns an empty list when gh fails', async () => {
    mocks.execMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'boom' });
    const { queryDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const runs = await queryDefaultBranchCi({
      projPath: '/repo',
      repo: 'owner/repo',
      defaultBranch: 'main',
      mergeSha: 'deadbeef',
    });
    expect(runs).toEqual([]);
  });

  it('returns an empty list when gh stdout is not valid JSON', async () => {
    mocks.execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'not json', stderr: '' });
    const { queryDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const runs = await queryDefaultBranchCi({
      projPath: '/repo',
      repo: 'owner/repo',
      defaultBranch: 'main',
      mergeSha: 'deadbeef',
    });
    expect(runs).toEqual([]);
  });

  it('parses the gh JSON payload into CiRun rows', async () => {
    mocks.execMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([
        { status: 'completed', conclusion: 'success', url: 'u1', workflowName: 'ci', databaseId: 1 },
        { status: 'in_progress', conclusion: null, url: 'u2', workflowName: 'slow', databaseId: 2 },
      ]),
      stderr: '',
    });
    const { queryDefaultBranchCi, classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const runs = await queryDefaultBranchCi({
      projPath: '/repo',
      repo: 'owner/repo',
      defaultBranch: 'main',
      mergeSha: 'deadbeef',
    });
    expect(runs).toHaveLength(2);
    expect(classifyDefaultBranchCi(runs).kind).toBe('pending');
  });
});

describe('start-soak — soak verdict flow', () => {
  beforeEach(() => {
    mocks.execMock.mockReset();
  });

  it('classifies the happy path as pass when every run completes successfully', async () => {
    const { classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const v = classifyDefaultBranchCi([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'neutral' },
    ]);
    expect(v.kind).toBe('pass');
  });

  it('classifies the fail path with the offending runs preserved for the revert PR body', async () => {
    const { classifyDefaultBranchCi, buildRevertPrBody } = await import('@/lib/pipeline/start-soak');
    const v = classifyDefaultBranchCi([
      { status: 'completed', conclusion: 'failure', workflowName: 'tests' },
      { status: 'completed', conclusion: 'success' },
    ]);
    expect(v.kind).toBe('fail');
    if (v.kind !== 'fail') return;
    const body = buildRevertPrBody(
      {
        mergeSha: 'abc1234',
        prRepo: 'owner/repo',
        prNumber: 1,
        prUrl: 'https://github.com/owner/repo/pull/1',
        defaultBranch: 'main',
        watchMinutes: 5,
        autoRevert: true,
      },
      v.failed,
    );
    expect(body).toContain('tests');
    expect(body).toContain('abc1234');
  });

  it('classifies the timeout path: pending runs leave the watcher waiting until the deadline', async () => {
    // The timeout itself is enforced by the workflow phase (deadlineAt). Here we
    // just verify the classifier reports `pending` so the workflow loop keeps
    // polling instead of treating partial CI as a green/red verdict.
    const { classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const v = classifyDefaultBranchCi([
      { status: 'queued', conclusion: null },
    ]);
    expect(v.kind).toBe('pending');
  });
});
