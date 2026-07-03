import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mocks, resetSharedMocks } from './start-push-fixtures';

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPathMock,
  clearProjectDataCache: mocks.clearProjectDataCacheMock,
}));
vi.mock('@/lib/shared/gh-status', () => ({ invalidateProject: mocks.invalidateProjectMock }));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));
vi.mock('@/lib/shared/config', () => ({
  getSettings: () => ({ commit_style: '' }),
  getPipelineModel: () => 'haiku',
  getPermissionModeFlag: () => '',
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
  setProjectPushResult: mocks.setProjectPushResultMock,
  getProjectTestConfig: mocks.getProjectTestConfigMock,
}));
vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: mocks.createJobMock,
  getJob: mocks.getJobMock,
  listJobs: mocks.listJobsMock,
  markDone: mocks.markDoneMock,
  updateJob: mocks.updateJobMock,
}));
vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  getLock: mocks.getLockMock,
  acquireLock: mocks.acquireLockMock,
  isLockOwnedByActiveRelease: mocks.isLockOwnedByActiveReleaseMock,
}));
vi.mock('@/lib/pipeline/start-commit', () => ({
  generateCommitMessage: mocks.generateCommitMessageMock,
  stageProjectChanges: mocks.stageProjectChangesMock,
  stageProjectChangesWithIndexLockRetry: mocks.stageProjectChangesMock,
  runGitIndexLockRetry: async (_projPath: string, _label: string, run: () => Promise<unknown>) => run(),
  isGitIndexLockError: (result: { exitCode: number; stdout: string; stderr: string }) => (
    result.exitCode !== 0 && /index\.lock|unable to create.*lock|another git process/i.test(`${result.stderr}\n${result.stdout}`)
  ),
  findIssueContext: mocks.findIssueContextMock,
  detectMainBranch: mocks.detectMainBranchMock,
  issueBranchName: mocks.issueBranchNameMock,
  deriveIssueContextFromBranch: mocks.deriveIssueContextFromBranchMock,
}));
vi.mock('@/lib/usage/resolve-provider', () => ({
  checkCliStartGate: mocks.checkCliStartGateMock,
}));
vi.mock('@/lib/jobs/parent-context', () => ({
  currentParent: mocks.currentParentMock,
}));
vi.mock('@/lib/pipeline/pause-project', () => ({
  pauseProject: mocks.pauseProjectMock,
}));
// Stub out the file-config loader so anything pulling it in does not shell
// out to `git` (via getBranchContext → execFileSync).
vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: () => null,
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: mocks.mkdirSyncMock,
    appendFileSync: mocks.appendFileSyncMock,
  };
});

// Single top-level import — all tests below share this resolved module graph.
import {
  launchProjectPush,
  pushCurrentBranch,
  validateReleaseLinkedPushRetry,
  validateReleaseLinkedCommitRetry,
} from '@/lib/pipeline/start-push';

describe('launchProjectPush — fire-and-forget', () => {
  const {
    execMock, createJobMock, updateJobMock, markDoneMock,
    mkdirSyncMock, appendFileSyncMock,
    getLockMock, acquireLockMock, resolveProjectPathMock,
    setProjectPushResultMock, checkCliStartGateMock,
  } = mocks;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function flush() {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    resetSharedMocks();
    // This block previously used a different logDir override.
    // Update the createJob impl to match its expected id format.
    createJobMock.mockImplementation((project: string, kind: string, pid: number, logPath: string) => ({
      id: `${project}-${kind}-launch-id`, project, kind, pid, logPath, prompt: null,
      startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
  });

  it('returns 409 error when a pipeline lock is already held', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'release-123', acquiredAt: Date.now() / 1000 });
    const result = await launchProjectPush('proj');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toContain('Pipeline is running');
    }
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('acquires the pipeline lock for standalone pushes', async () => {
    execMock.mockResolvedValue(resp(0));
    await launchProjectPush('proj');
    await flush();
    await flush();
    expect(acquireLockMock).toHaveBeenCalled();
  });

  it('marks the background job blocked when the CLI start gate rejects the push', async () => {
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'budget blocked',
    });

    const result = await launchProjectPush('proj');

    expect(result).toEqual({ jobId: 'proj-push-launch-id' });
    await flush();
    await flush();

    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', 'budget blocked');
    const lastMarkDone = markDoneMock.mock.calls[markDoneMock.mock.calls.length - 1];
    expect(lastMarkDone[1]).toBe(1);
  });

  it('aborts the push when async acquireLock loses the race', async () => {
    execMock.mockResolvedValue(resp(0));
    acquireLockMock.mockResolvedValueOnce({ acquired: false, lock: { project: 'proj', lockedByJobId: 'release-99', acquiredAt: Date.now() / 1000 }, blockingJobId: 'release-99' });
    const result = await launchProjectPush('proj');
    expect('jobId' in result).toBe(true);
    await flush();
    await flush();
    await flush();
    // No git push exec call should have been issued.
    const pushCalls = execMock.mock.calls.filter(([cmd, args]) => cmd === 'git' && Array.isArray(args) && args.includes('push'));
    expect(pushCalls.length).toBe(0);
    // Job should have been marked done with non-zero exit.
    expect(markDoneMock).toHaveBeenCalled();
    const lastMarkDone = markDoneMock.mock.calls[markDoneMock.mock.calls.length - 1];
    expect(lastMarkDone[1]).toBe(1);
  });

  it('returns error object immediately when project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const result = await launchProjectPush('nonexistent');
    expect(result).toEqual({ error: 'project not found' });
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('returns jobId when project exists', async () => {
    execMock.mockResolvedValue(resp(0));
    const result = await launchProjectPush('proj');
    expect('jobId' in result).toBe(true);
    if ('jobId' in result) {
      expect(typeof result.jobId).toBe('string');
      expect(result.jobId.length).toBeGreaterThan(0);
    }
  });

  it('creates a job and updates it with logPath before returning', async () => {
    execMock.mockResolvedValue(resp(0));
    await launchProjectPush('proj');
    expect(createJobMock).toHaveBeenCalled();
    const [cjProject, cjKind, cjPid, cjLog] = createJobMock.mock.calls[0];
    expect(cjProject).toBe('proj');
    expect(cjKind).toBe('push');
    expect(cjPid).toEqual(expect.any(Number));
    expect(cjLog).toBe('');
    // The first updateJob call must stamp logPath before the function returns.
    // Subsequent calls (e.g. setting job.provider after the CLI gate check) are
    // emitted from the background IIFE; their visibility depends on how many
    // microtasks have drained by the time the test inspects state, which is
    // not part of this test's contract.
    expect(updateJobMock).toHaveBeenCalled();
    const updatedJob = updateJobMock.mock.calls[0][0];
    expect(updatedJob.logPath).toMatch(/\.log$/);
  });

  it('job ID in return value matches the created job ID', async () => {
    execMock.mockResolvedValue(resp(0));
    const result = await launchProjectPush('proj');
    if ('jobId' in result) {
      const createdJobId = createJobMock.mock.results[0].value.id;
      expect(result.jobId).toBe(createdJobId);
    }
  });

  it('marks job done with exit 0 after successful background push', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '', ''))         // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));     // git rev-parse HEAD

    await launchProjectPush('proj');
    await flush();
    await flush();

    expect(markDoneMock).toHaveBeenCalled();
    const [, exitCode] = markDoneMock.mock.calls[0];
    expect(exitCode).toBe(0);
  });

  it('marks job done with exit 1 after failed background push', async () => {
    execMock
      .mockImplementationOnce(() => resp(1, '', 'remote: rejected'));  // git push fails

    await launchProjectPush('proj');
    await flush();
    await flush();

    expect(markDoneMock).toHaveBeenCalled();
    const [, exitCode] = markDoneMock.mock.calls[0];
    expect(exitCode).toBe(1);
  });

  it('writes a start header to the log file immediately', async () => {
    execMock.mockResolvedValue(resp(0));
    await launchProjectPush('proj');
    expect(appendFileSyncMock).toHaveBeenCalled();
    const firstWrite: string = appendFileSyncMock.mock.calls[0][1];
    expect(firstWrite).toContain('push start');
    expect(firstWrite).toContain('/path/to/proj');
  });

  it('creates logDir with recursive mkdirSync', async () => {
    execMock.mockResolvedValue(resp(0));
    await launchProjectPush('proj');
    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp', { recursive: true });
  });
});

describe('pushCurrentBranch', () => {
  const { execMock } = mocks;

  const resp = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr });

  beforeEach(() => {
    resetSharedMocks();
  });

  it('returns ok with commitSha on clean push', async () => {
    execMock
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'abc1234\n'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commitSha).toBe('abc1234');
  });

  it('returns empty commitSha when rev-parse fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(1, ''));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commitSha).toBe('');
  });

  it('retries with -u origin <branch> on "no upstream" error', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, '', 'error: The current branch has no upstream branch'))
      .mockResolvedValueOnce(resp(0, 'feat/x\n'))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'def5678\n'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(true);
    const upstreamCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('-u')
    );
    expect(upstreamCall).toBeTruthy();
    expect(upstreamCall![1]).toContain('feat/x');
  });

  it('retries with -u origin <branch> on "set-upstream" error', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, '', 'fatal: The current branch has no upstream. To push the current branch and set the remote as upstream, use --set-upstream'))
      .mockResolvedValueOnce(resp(0, 'fix/issue-5\n'))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'aaa0001\n'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(true);
  });

  it('skips upstream retry when git branch returns empty (detached HEAD)', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, '', 'error: no upstream branch'))
      .mockResolvedValueOnce(resp(0, '\n'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('Push failed');
    // Only 2 exec calls — no third push attempt since branch name is empty
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('returns ok: false with detail when push fails for a non-upstream reason', async () => {
    execMock.mockResolvedValueOnce(resp(1, '', 'remote: permission denied'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('Push failed');
      expect(result.detail).toContain('permission denied');
    }
  });

  it('falls back to stdout in error detail when stderr is empty', async () => {
    execMock.mockResolvedValueOnce(resp(1, 'some stdout error', ''));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('some stdout error');
  });

  it('uses generic exit-code message when both stdout and stderr are empty', async () => {
    execMock.mockResolvedValueOnce(resp(2, '', ''));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('exited 2');
  });

  it('calls the log callback with push command and stdout', async () => {
    const logs: string[] = [];
    execMock
      .mockResolvedValueOnce(resp(0, 'branch info\n', ''))
      .mockResolvedValueOnce(resp(0, 'sha123\n'));

    await pushCurrentBranch('/repo', (s) => logs.push(s));
    expect(logs.some((l) => l.includes('git push'))).toBe(true);
    expect(logs.some((l) => l.includes('branch info'))).toBe(true);
  });

  it('passes the project path via -C to all git invocations', async () => {
    execMock
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'sha\n'));

    await pushCurrentBranch('/my/custom/path');
    for (const [cmd, args] of execMock.mock.calls as [string, string[]][]) {
      if (cmd === 'git') expect(args).toContain('/my/custom/path');
    }
  });

  it('forwards --no-verify to git push when noVerify is set', async () => {
    execMock
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'sha\n'));

    await pushCurrentBranch('/repo', undefined, { noVerify: true });
    const pushCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('push'),
    );
    expect(pushCall).toBeTruthy();
    expect(pushCall![1]).toContain('--no-verify');
  });

  it('does not pass --no-verify by default', async () => {
    execMock
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'sha\n'));

    await pushCurrentBranch('/repo');
    const pushCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('push'),
    );
    expect(pushCall![1]).not.toContain('--no-verify');
  });

  it('fetches and rebases before retrying when push is rejected as behind the remote', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, '', '! [rejected] master -> master (fetch first)'))
      .mockResolvedValueOnce(resp(0, 'feature-x\n'))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'abc1234\n'));

    const result = await pushCurrentBranch('/repo');

    expect(result.ok).toBe(true);
    const fetchCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('fetch'),
    );
    const rebaseCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('rebase') && args.includes('FETCH_HEAD'),
    );
    expect(fetchCall).toBeTruthy();
    expect(rebaseCall).toBeTruthy();
  });

  it('detects retryable non-fast-forward variants case-insensitively', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, '', '! [rejected] main -> main (Non-Fast-Forward)'))
      .mockResolvedValueOnce(resp(0, 'main\n'))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(0, 'abc1234\n'));

    const result = await pushCurrentBranch('/repo');

    expect(result.ok).toBe(true);
    const rebaseCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('rebase') && args.includes('FETCH_HEAD'),
    );
    expect(rebaseCall).toBeTruthy();
  });

  it('does not rebase protection-only remote denials', async () => {
    execMock.mockResolvedValueOnce(resp(1, '', 'remote: - Changes must be made through a pull request.'));

    const result = await pushCurrentBranch('/repo');

    expect(result.ok).toBe(false);
    const rebaseCalls = (execMock.mock.calls as [string, string[]][]).filter(
      ([cmd, args]) => cmd === 'git' && args.includes('rebase'),
    );
    expect(rebaseCalls).toHaveLength(0);
  });

  it('reports a clear fetch failure when behind-remote recovery cannot start', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, '', 'error: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.'))
      .mockResolvedValueOnce(resp(0, 'feature-x\n'))
      .mockResolvedValueOnce(resp(1, '', 'cannot open .git/FETCH_HEAD: Operation not permitted'));

    const result = await pushCurrentBranch('/repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('Fetch failed before push');
      expect(result.hookFailure).toBe(null);
    }
  });

  it('aborts and pauses when behind-remote recovery hits a rebase conflict', async () => {
    execMock
      .mockResolvedValueOnce(resp(1, '', '! [rejected] main -> main (fetch first)'))
      .mockResolvedValueOnce(resp(0, 'main\n'))
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(1, '', 'CONFLICT (content): Merge conflict in app.ts'))
      .mockResolvedValueOnce(resp(0));

    const result = await pushCurrentBranch('/repo', undefined, { projectName: 'proj' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('Merge conflict');
      expect(result.detail).toContain('rebase aborted');
      expect(result.detail).toContain('paused');
      expect(result.hookFailure).toBe(null);
    }
    const abortCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('rebase') && args.includes('--abort'),
    );
    expect(abortCall).toBeTruthy();
    expect(mocks.pauseProjectMock).toHaveBeenCalledWith('proj', expect.stringContaining('locally, then resume.'));
  });

  it('classifies pre-push hook test failures as hookFailure: pre-push-tests', async () => {
    execMock.mockResolvedValueOnce(resp(1, '', '✗ FAIL middleware.utils.test.ts > isAdminRole\n  AssertionError: expected false to be true\n  Failed Tests 1\n'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hookFailure).toBe('pre-push-tests');
      expect(result.detail).toContain('Failed Tests');
    }
  });

  it('classifies non-test pre-push hook failures (lint/typecheck) as hookFailure: pre-push-other', async () => {
    execMock.mockResolvedValueOnce(resp(1, '', 'eslint: 12 errors\n7:5  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hookFailure).toBe('pre-push-other');
  });

  it('returns hookFailure: null for non-hook failures (auth, network, non-fast-forward)', async () => {
    execMock.mockResolvedValueOnce(resp(1, '', 'fatal: Authentication failed for github.com'));

    const result = await pushCurrentBranch('/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hookFailure).toBe(null);
  });
});

describe('validateReleaseLinkedCommitRetry', () => {
  const { getJobMock, listJobsMock, getLockMock } = mocks;

  function makeRelease(id: string, project: string, opts: { startedAt?: number; finishedAt?: number | null } = {}) {
    return { id, project, kind: 'release' as const, startedAt: opts.startedAt ?? 1000, finishedAt: opts.finishedAt ?? 2000, exitCode: 1 };
  }
  function makeStep(kind: string, opts: { releaseId: string; project?: string; startedAt?: number; finishedAt?: number | null; exitCode?: number | null }) {
    return {
      id: `${opts.project ?? 'proj'}-${kind}-${opts.startedAt ?? 1500}`,
      project: opts.project ?? 'proj', kind, releaseId: opts.releaseId,
      startedAt: opts.startedAt ?? 1500, finishedAt: opts.finishedAt ?? 1800, exitCode: opts.exitCode ?? 0,
    };
  }

  beforeEach(() => {
    resetSharedMocks();
  });

  it('returns ok with null parent when no releaseId is given', async () => {
    expect(await validateReleaseLinkedCommitRetry('proj', null)).toEqual({ ok: true, parentJobId: null, releaseLinkedRetry: false });
  });

  it('rejects 404 when the release id does not exist', async () => {
    getJobMock.mockReturnValue(null);
    const r = await validateReleaseLinkedCommitRetry('proj', 'missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('rejects when the release is not the latest for the project', async () => {
    const older = makeRelease('older', 'proj', { startedAt: 1000 });
    const newer = makeRelease('newer', 'proj', { startedAt: 2000 });
    getJobMock.mockReturnValue(older);
    listJobsMock.mockReturnValue([older, newer]);
    const r = await validateReleaseLinkedCommitRetry('proj', 'older');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.detail).toContain('latest release'); }
  });

  it('rejects when the latest step on the release is not a failed commit', async () => {
    const release = makeRelease('rel', 'proj');
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      release,
      makeStep('push', { releaseId: 'rel', startedAt: 1500, exitCode: 1 }),
    ]);
    const r = await validateReleaseLinkedCommitRetry('proj', 'rel');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('failed commit');
  });

  it('accepts a failed commit on the latest finished release (the seo-tools repro)', async () => {
    const release = makeRelease('rel', 'proj', { finishedAt: 3000 });
    const failedCommit = makeStep('commit', { releaseId: 'rel', startedAt: 2500, finishedAt: 2700, exitCode: -1 });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      release,
      makeStep('test', { releaseId: 'rel', startedAt: 1100, exitCode: 0 }),
      makeStep('review', { releaseId: 'rel', startedAt: 1300, exitCode: 0 }),
      failedCommit,
    ]);
    const r = await validateReleaseLinkedCommitRetry('proj', 'rel');
    expect(r).toEqual({ ok: true, parentJobId: 'rel', releaseLinkedRetry: true });
  });

  it('rejects when another pipeline holds the project lock (avoid racing in-flight work)', async () => {
    const release = makeRelease('rel', 'proj', { finishedAt: 3000 });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release]);
    getLockMock.mockReturnValue({ lockedByJobId: 'other-release-job' });
    const r = await validateReleaseLinkedCommitRetry('proj', 'rel');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('Pipeline is running');
  });
});

describe('validateReleaseLinkedPushRetry', () => {
  const { getJobMock, listJobsMock, getLockMock, isLockOwnedByActiveReleaseMock } = mocks;

  function makeRelease(id: string, project: string, opts: { startedAt?: number; finishedAt?: number | null } = {}) {
    return {
      id,
      project,
      kind: 'release' as const,
      startedAt: opts.startedAt ?? 1000,
      finishedAt: Object.prototype.hasOwnProperty.call(opts, 'finishedAt') ? opts.finishedAt ?? null : 2000,
      exitCode: 1,
    };
  }
  function makeStep(kind: string, opts: { releaseId: string; project?: string; startedAt?: number; finishedAt?: number | null; exitCode?: number | null }) {
    return {
      id: `${opts.project ?? 'proj'}-${kind}-${opts.startedAt ?? 1500}`,
      project: opts.project ?? 'proj', kind, releaseId: opts.releaseId,
      startedAt: opts.startedAt ?? 1500, finishedAt: opts.finishedAt ?? 1800, exitCode: opts.exitCode ?? 0,
    };
  }

  beforeEach(() => {
    resetSharedMocks();
  });

  it('returns ok with null parent when no releaseId is given', async () => {
    expect(await validateReleaseLinkedPushRetry('proj', null)).toEqual({ ok: true, parentJobId: null, releaseLinkedRetry: false });
  });

  it('keeps active release retries on the strict active-lock path', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'rel', acquiredAt: Date.now() / 1000 });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    getJobMock.mockReturnValue(makeRelease('rel', 'proj', { finishedAt: null }));
    listJobsMock.mockReturnValue([
      makeStep('push', { releaseId: 'rel', startedAt: 2500, finishedAt: 2700, exitCode: 1 }),
    ]);
    const r = await validateReleaseLinkedPushRetry('proj', 'rel');
    expect(r).toEqual({ ok: true, parentJobId: 'rel', releaseLinkedRetry: true });
  });

  it('accepts a failed push on the latest finished release', async () => {
    const release = makeRelease('rel', 'proj', { finishedAt: 3000 });
    const failedPush = makeStep('push', { releaseId: 'rel', startedAt: 2500, finishedAt: 2700, exitCode: 1 });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      release,
      makeStep('test', { releaseId: 'rel', startedAt: 1100, exitCode: 0 }),
      makeStep('commit', { releaseId: 'rel', startedAt: 2100, exitCode: 0 }),
      failedPush,
    ]);
    const r = await validateReleaseLinkedPushRetry('proj', 'rel');
    expect(r).toEqual({ ok: true, parentJobId: 'rel', releaseLinkedRetry: true });
  });

  it('rejects when the release is not the latest for the project', async () => {
    const older = makeRelease('older', 'proj', { startedAt: 1000 });
    const newer = makeRelease('newer', 'proj', { startedAt: 2000 });
    getJobMock.mockReturnValue(older);
    listJobsMock.mockReturnValue([older, newer]);
    const r = await validateReleaseLinkedPushRetry('proj', 'older');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.detail).toContain('latest release'); }
  });

  it('rejects when the latest step on the release is not a failed push', async () => {
    const release = makeRelease('rel', 'proj');
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      release,
      makeStep('commit', { releaseId: 'rel', startedAt: 1500, exitCode: 1 }),
    ]);
    const r = await validateReleaseLinkedPushRetry('proj', 'rel');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('failed push');
  });

  it('rejects when another pipeline holds the project lock', async () => {
    const release = makeRelease('rel', 'proj', { finishedAt: 3000 });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release]);
    getLockMock.mockReturnValue({ lockedByJobId: 'other-release-job' });
    const r = await validateReleaseLinkedPushRetry('proj', 'rel');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('Pipeline is running');
  });
});
