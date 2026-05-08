import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueBranchName } from '@/lib/pipeline/start-commit';

describe('issueBranchName', () => {
  it('produces fix/issue-N-slug from a normal title', () => {
    expect(issueBranchName({ number: 42, title: 'Fix login bug' })).toBe('fix/issue-42-fix-login-bug');
  });

  it('replaces non-alphanumeric chars with dashes and lowercases', () => {
    expect(issueBranchName({ number: 7, title: 'Add OAuth2 support (GitHub)' })).toBe('fix/issue-7-add-oauth2-support-github');
  });

  it('trims leading and trailing dashes from the slug', () => {
    expect(issueBranchName({ number: 1, title: '---Edge case!---' })).toBe('fix/issue-1-edge-case');
  });

  it('truncates slug at 40 chars', () => {
    const longTitle = 'A'.repeat(60);
    const result = issueBranchName({ number: 5, title: longTitle });
    const slug = result.replace('fix/issue-5-', '');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('omits the slug portion when the title produces an empty slug', () => {
    expect(issueBranchName({ number: 3, title: '---!!!---' })).toBe('fix/issue-3');
  });

  it('handles a purely numeric title', () => {
    expect(issueBranchName({ number: 10, title: '12345' })).toBe('fix/issue-10-12345');
  });
});

describe('startProjectCommit', () => {
  let setProjectPushResultMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let findActiveReleaseJobMock: ReturnType<typeof vi.fn>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    setProjectPushResultMock = vi.fn();
    checkCliStartGateMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });
    getProjectTestConfigMock = vi.fn().mockReturnValue(null);
    listJobsMock = vi.fn().mockReturnValue([]);
    findActiveReleaseJobMock = vi.fn().mockReturnValue(null);
    getJobMock = vi.fn().mockReturnValue(null);
    execMock = vi.fn();
    createJobMock = vi.fn().mockImplementation((project: string, kind: string, pid: number, logPath: string) => ({
      id: `${project}-${kind}-job`,
      project,
      kind,
      pid,
      logPath,
      prompt: null,
      startedAt: 0,
      finishedAt: null,
      exitCode: null,
      seen: false,
      contextMeta: null,
      userPrompt: null,
    }));
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    updateJobMock = vi.fn();

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
      getProjectTestConfig: getProjectTestConfigMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ commit_style: '' }),
      getPipelineModel: () => 'normal',
    }));
    vi.doMock('@/lib/shared/cli-bin', () => ({
      resolveCliBin: vi.fn().mockReturnValue('codex'),
      resolveCliEnv: vi.fn().mockReturnValue({}),
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
      createJob: createJobMock,
      markDone: markDoneMock,
      updateJob: updateJobMock,
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

  it('passes an explicit parentJobId to the CLI start gate for release-linked retries', async () => {
    const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
    const result = await startProjectCommit('proj', { parentJobId: 'release-456' });
    expect(result.ok).toBe(false);
    expect(checkCliStartGateMock).toHaveBeenCalledWith('start a commit', { parentJobId: 'release-456' });
  });

  it('runs git commit with process-tree cancellation enabled', async () => {
    checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'codex' });
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git add -A
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M src/index.ts\n', stderr: '' }) // git diff --cached --name-status
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' src/index.ts | 1 +\n', stderr: '' }) // git diff --stat
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'diff --git a/src/index.ts b/src/index.ts\n', stderr: '' }) // git diff
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'feat: ship it\n', stderr: '' }) // codex
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[main abc123] feat: ship it\n', stderr: '' }) // git commit
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123\n', stderr: '' }); // git rev-parse

    const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
    const result = await startProjectCommit('proj');

    expect(result.ok).toBe(true);
    const commitCall = execMock.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args[0] === '-C' && args[2] === 'commit',
    );
    expect(commitCall?.[2]).toMatchObject({
      timeout: 30000,
      abortProcessTree: true,
      signal: expect.any(Object),
    });
    expect(markDoneMock).toHaveBeenCalledWith(createJobMock.mock.results[0].value, 0);
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

  it('findIssueContext skips closed issues and falls back to the next open candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));
    listJobsMock.mockReturnValue([
      {
        id: 'issue-42-run',
        project: 'proj',
        kind: 'run',
        startedAt: Date.now() / 1000 - 60,
        parentJobId: null,
        ghIssueNumber: 42,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Closed issue',
      },
      {
        id: 'issue-41-run',
        project: 'proj',
        kind: 'run',
        startedAt: Date.now() / 1000 - 120,
        parentJobId: null,
        ghIssueNumber: 41,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Still open',
      },
    ]);
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'main\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"state":"CLOSED"}', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"state":"OPEN"}', stderr: '' });

    const { findIssueContext } = await import('@/lib/pipeline/start-commit');
    await expect(findIssueContext('proj', '/path/to/proj')).resolves.toEqual({
      number: 41,
      repo: 'owner/repo',
      title: 'Still open',
    });
  });

  it('detectMainBranch returns the remote HEAD branch when available', async () => {
    execMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'refs/remotes/origin/trunk\n',
      stderr: '',
    });

    const { detectMainBranch } = await import('@/lib/pipeline/start-commit');
    await expect(detectMainBranch('/path/to/proj')).resolves.toBe('trunk');
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('detectMainBranch falls back to main when origin HEAD is unavailable but main exists', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no origin head' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'deadbeef\n', stderr: '' });

    const { detectMainBranch } = await import('@/lib/pipeline/start-commit');
    await expect(detectMainBranch('/path/to/proj')).resolves.toBe('main');
  });

  it('detectMainBranch falls back to master when origin HEAD is unavailable and main is missing', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no origin head' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'unknown revision' });

    const { detectMainBranch } = await import('@/lib/pipeline/start-commit');
    await expect(detectMainBranch('/path/to/proj')).resolves.toBe('master');
  });
});
