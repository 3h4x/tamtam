import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  issueBranchName,
  deriveIssueContextFromBranch,
  clearStaleIndexLock,
  processTableHasPotentialGitIndexOwner,
} from '@/lib/pipeline/start-commit';

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

describe('clearStaleIndexLock', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tamtam-lock-')); mkdirSync(join(dir, '.git'), { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const lockPath = () => join(dir, '.git', 'index.lock');

  it('removes an old orphaned lock so commits can proceed', async () => {
    writeFileSync(lockPath(), '');
    // Backdate the lock well past the conservative stale threshold.
    const old = Date.now() / 1000 - 15 * 60;
    utimesSync(lockPath(), old, old);
    expect(await clearStaleIndexLock(dir, () => {}, {
      isGitProcessActive: async () => false,
    })).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('keeps a fresh lock (a live git op may still own it)', async () => {
    writeFileSync(lockPath(), '');
    expect(await clearStaleIndexLock(dir)).toBe(false);
    expect(existsSync(lockPath())).toBe(true);
  });

  it('keeps an old lock when a git process for the project is still active', async () => {
    writeFileSync(lockPath(), '');
    const old = Date.now() / 1000 - 15 * 60;
    utimesSync(lockPath(), old, old);
    expect(await clearStaleIndexLock(dir, () => {}, {
      isGitProcessActive: async () => true,
    })).toBe(false);
    expect(existsSync(lockPath())).toBe(true);
  });

  it('is a no-op when no lock exists', async () => {
    expect(await clearStaleIndexLock(dir)).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe('processTableHasPotentialGitIndexOwner', () => {
  const projPath = '/work/proj';
  const lockPath = '/work/proj/.git/index.lock';

  it('ignores unrelated git commands with explicit repository paths', () => {
    const ps = [
      '123 git -C /work/other commit -m unrelated',
      '124 /usr/bin/git --git-dir=/work/else/.git status',
      '125 git status',
    ].join('\n');

    expect(processTableHasPotentialGitIndexOwner(ps, projPath, lockPath)).toBe(false);
  });

  it('treats project-scoped git commands as potential lock owners', () => {
    const ps = '123 git -C /work/proj status';

    expect(processTableHasPotentialGitIndexOwner(ps, projPath, lockPath)).toBe(true);
  });

  it('preserves the lock for mutating git commands with unknown cwd', () => {
    const ps = '123 /usr/bin/git commit -m update';

    expect(processTableHasPotentialGitIndexOwner(ps, projPath, lockPath)).toBe(true);
  });
});

describe('deriveIssueContextFromBranch', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let derive: typeof deriveIssueContextFromBranch;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    ({ deriveIssueContextFromBranch: derive } = await import('@/lib/pipeline/start-commit'));
  });

  afterEach(() => {
    vi.doUnmock('@/lib/shared/shell');
  });

  it('returns null when current branch does not match fix/issue-N pattern', async () => {
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'feature/foo\n', stderr: '' });
    expect(await derive('/repo')).toBeNull();
  });

  it('returns issue context when on fix/issue-N branch with open issue', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-26-foo\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 't3rn/portal\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ title: 'Fix stake page', state: 'OPEN' }), stderr: '' });
    expect(await derive('/repo')).toEqual({ number: 26, repo: 't3rn/portal', title: 'Fix stake page' });
  });

  it('returns null when the issue is already closed', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-7\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'owner/repo\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ title: 'Done', state: 'CLOSED' }), stderr: '' });
    expect(await derive('/repo')).toBeNull();
  });

  it('returns null when git branch command fails', async () => {
    execMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repo' });
    expect(await derive('/repo')).toBeNull();
  });

  it('returns null when gh repo view fails', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-10-bug\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'gh: no repo' });
    expect(await derive('/repo')).toBeNull();
  });

  it('returns null when gh issue view fails', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-10-bug\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'owner/repo\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'gh: not found' });
    expect(await derive('/repo')).toBeNull();
  });

  it('returns null when issue JSON is malformed', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-11-crash\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'owner/repo\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'not-json', stderr: '' });
    expect(await derive('/repo')).toBeNull();
  });

  it('returns null when issue title is empty', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-12-empty\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'owner/repo\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ title: '   ', state: 'OPEN' }), stderr: '' });
    expect(await derive('/repo')).toBeNull();
  });

  it('returns issue context when state is absent (treated as open)', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fix/issue-15-feature\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'owner/repo\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ title: 'Add feature' }), stderr: '' });
    expect(await derive('/repo')).toEqual({ number: 15, repo: 'owner/repo', title: 'Add feature' });
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
  let setDefaultDirtyCommitRecoveryMarkerMock: ReturnType<typeof vi.fn>;
  let clearDefaultDirtyCommitRecoveryMarkerMock: ReturnType<typeof vi.fn>;

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
    setDefaultDirtyCommitRecoveryMarkerMock = vi.fn().mockResolvedValue(undefined);
    clearDefaultDirtyCommitRecoveryMarkerMock = vi.fn().mockResolvedValue(undefined);

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
      getPermissionModeFlag: () => '--permission-mode acceptEdits',
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
    vi.doMock('@/lib/pipeline/commit-recovery-marker', () => ({
      setDefaultDirtyCommitRecoveryMarker: setDefaultDirtyCommitRecoveryMarkerMock,
      clearDefaultDirtyCommitRecoveryMarker: clearDefaultDirtyCommitRecoveryMarkerMock,
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
    const addCall = execMock.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args[0] === '-C' && args[2] === 'add',
    );
    const generatorCall = execMock.mock.calls.find(
      ([cmd, args]) => cmd === 'codex' && Array.isArray(args) && args.includes('--print'),
    );
    expect(addCall?.[1]).toEqual(expect.arrayContaining([':(exclude).tamtam/cache/**']));
    expect(generatorCall?.[1]).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(commitCall?.[2]).toMatchObject({
      timeout: 30000,
      abortProcessTree: true,
      signal: expect.any(Object),
    });
    expect(clearDefaultDirtyCommitRecoveryMarkerMock).toHaveBeenCalledWith('proj');
    expect(markDoneMock).toHaveBeenCalledWith(createJobMock.mock.results[0].value, 0);
  });

  it('records a default-dirty recovery marker when staging fails on the default branch', async () => {
    checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'codex' });
    execMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fatal: unable to add file' }) // git add -A
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'main\n', stderr: '' }) // branch --show-current
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' }) // origin HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/index.ts\n', stderr: '' }); // status

    const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
    const result = await startProjectCommit('proj');

    expect(result.ok).toBe(false);
    expect(setDefaultDirtyCommitRecoveryMarkerMock).toHaveBeenCalledWith(
      'proj',
      ' M src/index.ts\n',
      'proj-commit-job',
    );
    expect(markDoneMock).toHaveBeenCalledWith(createJobMock.mock.results[0].value, 1);
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
