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

  it('reports `pending` so the soak loop keeps polling — there is no upper time cap', async () => {
    // soak now polls until verdict !== 'pending' (and treats `none` as
    // "no CI configured" only after the 90s grace window). `pending` keeps
    // the watcher waiting indefinitely.
    const { classifyDefaultBranchCi } = await import('@/lib/pipeline/start-soak');
    const v = classifyDefaultBranchCi([
      { status: 'queued', conclusion: null },
    ]);
    expect(v.kind).toBe('pending');
  });
});

describe('start-soak — pauseProjectForSoakFailure', () => {
  beforeEach(() => {
    mocks.execMock.mockReset();
    vi.resetModules();
  });

  it('flips projects.paused = true via Drizzle update and refreshes the admission-gate cache', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });
    const refreshMock = vi.fn().mockResolvedValue(undefined);
    const clearMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: { update: updateMock } }));
    vi.doMock('@/lib/db/schema', () => ({ projects: { name: 'name_col' } }));
    vi.doMock('@/lib/shared/project-data', () => ({ clearProjectDataCache: clearMock }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({ refreshProjectsCacheSync: refreshMock }));

    const { pauseProjectForSoakFailure } = await import('@/lib/pipeline/start-soak');
    const ok = await pauseProjectForSoakFailure('tamtam');

    expect(ok).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith({ paused: true });
    // Cache invalidation must happen so the in-process `isProjectPaused()`
    // gate sees the new state on the next admission check.
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);

    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/db/schema');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/shared/enabled-projects');
  });

  it('returns false (and does not throw) when the DB update fails', async () => {
    const whereMock = vi.fn().mockRejectedValue(new Error('connection lost'));
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });

    vi.doMock('@/lib/db', () => ({ db: { update: updateMock } }));
    vi.doMock('@/lib/db/schema', () => ({ projects: { name: 'name_col' } }));
    vi.doMock('@/lib/shared/project-data', () => ({ clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({ refreshProjectsCacheSync: vi.fn() }));

    const { pauseProjectForSoakFailure } = await import('@/lib/pipeline/start-soak');

    // Silence the expected error log during the test.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await pauseProjectForSoakFailure('tamtam');
    errSpy.mockRestore();

    expect(ok).toBe(false);

    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/db/schema');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/shared/enabled-projects');
  });
});

describe('start-soak — verdict-driven loop semantics (workflow-phase regression guards)', () => {
  it('exposes the 90s grace constant for the no-CI-configured case', async () => {
    const { SOAK_NO_CHECKS_GRACE_MS } = await import('@/lib/workflows/phases/soak-phase');
    expect(SOAK_NO_CHECKS_GRACE_MS).toBe(90_000);
  });
});
