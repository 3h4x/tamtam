import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('startProjectCommit', () => {
  let setProjectPushResultMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let findActiveReleaseJobMock: ReturnType<typeof vi.fn>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    setProjectPushResultMock = vi.fn();
    checkCliStartGateMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });
    listJobsMock = vi.fn().mockReturnValue([]);
    findActiveReleaseJobMock = vi.fn().mockReturnValue(null);
    getJobMock = vi.fn().mockReturnValue(null);
    execMock = vi.fn();

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp' }),
      setProjectPushResult: setProjectPushResultMock,
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(),
      markDone: vi.fn(),
      updateJob: vi.fn(),
      listJobs: listJobsMock,
      findActiveReleaseJob: findActiveReleaseJobMock,
      getJob: getJobMock,
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      listJobs: listJobsMock,
      findActiveReleaseJob: findActiveReleaseJobMock,
      getJob: getJobMock,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns 429 when every enabled provider is over budget', async () => {
    const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
    const result = await startProjectCommit('proj');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(429);
    expect(setProjectPushResultMock).toHaveBeenCalledWith(
      'proj',
      'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    );
  });

  it('findIssueContext recovers issue metadata from the active release trigger chain', async () => {
    const releaseJob = {
      id: 'release-1',
      project: 'proj',
      kind: 'release',
      startedAt: 2_000,
      parentJobId: 'run-issue',
      ghIssueNumber: null,
    };
    const sourceRun = {
      id: 'run-issue',
      project: 'proj',
      kind: 'run',
      startedAt: 1_000,
      parentJobId: null,
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Fix login bug',
    };
    const unrelatedRun = {
      id: 'run-other',
      project: 'proj',
      kind: 'run',
      startedAt: 9_000,
      parentJobId: null,
      ghIssueNumber: 99,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Do not pick me',
    };

    findActiveReleaseJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([sourceRun, unrelatedRun]);
    getJobMock.mockImplementation((id: string) => (id === 'run-issue' ? sourceRun : null));
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-42-fix-login-bug\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"state":"OPEN"}', stderr: '' });

    const { findIssueContext } = await import('@/lib/pipeline/start-commit');
    await expect(findIssueContext('proj', '/path/to/proj')).resolves.toEqual({
      number: 42,
      repo: 'owner/repo',
      title: 'Fix login bug',
    });
  });

  it('findIssueContext still ignores stale non-release issue runs when no release is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));
    listJobsMock.mockReturnValue([
      {
        id: 'old-run',
        project: 'proj',
        kind: 'run',
        startedAt: Date.now() / 1000 - 31 * 60,
        parentJobId: null,
        ghIssueNumber: 42,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Too old',
      },
    ]);

    const { findIssueContext } = await import('@/lib/pipeline/start-commit');
    await expect(findIssueContext('proj', '/path/to/proj')).resolves.toBeNull();
  });

  it('findIssueContext skips a newer unrelated issue run when the current branch matches an older issue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));
    listJobsMock.mockReturnValue([
      {
        id: 'issue-42-run',
        project: 'proj',
        kind: 'run',
        startedAt: Date.now() / 1000 - 120,
        parentJobId: null,
        ghIssueNumber: 42,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Fix login bug',
      },
      {
        id: 'issue-99-run',
        project: 'proj',
        kind: 'run',
        startedAt: Date.now() / 1000 - 60,
        parentJobId: null,
        ghIssueNumber: 99,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Wrong issue',
      },
    ]);
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-42-fix-login-bug\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"state":"OPEN"}', stderr: '' });

    const { findIssueContext } = await import('@/lib/pipeline/start-commit');
    await expect(findIssueContext('proj', '/path/to/proj')).resolves.toEqual({
      number: 42,
      repo: 'owner/repo',
      title: 'Fix login bug',
    });
  });
});
