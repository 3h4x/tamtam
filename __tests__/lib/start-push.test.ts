import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mocks, defaultCreateJob, resetSharedMocks } from './start-push-fixtures';

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
  startProjectPush,
  launchProjectPush,
} from '@/lib/pipeline/start-push';

describe('startProjectPush — push mechanics', () => {
  const {
    execMock, setProjectPushResultMock, createJobMock, markDoneMock,
    generateCommitMessageMock, checkCliStartGateMock, getProjectTestConfigMock,
    getLockMock, acquireLockMock, isLockOwnedByActiveReleaseMock,
    getJobMock, listJobsMock, resolveProjectPathMock,
    findIssueContextMock, deriveIssueContextFromBranchMock,
    pauseProjectMock,
  } = mocks;

  beforeEach(() => {
    resetSharedMocks();
  });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  it('stores null error on successful push (no commits to push initially, then pushes)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                         // git rev-list --count @{u}..HEAD (1 ahead)
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));                    // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('passes an explicit parentJobId to the CLI start gate for release-linked retries', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0, 'abc1234'));

    const r = await startProjectPush('proj', { parentJobId: 'release-123' });

    expect(r.ok).toBe(true);
    expect(checkCliStartGateMock).toHaveBeenCalledWith('start a push', { parentJobId: 'release-123' });
  });

  it('launchProjectPush keeps a release-linked retry under the active release lock and gate context', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'release-123', acquiredAt: Date.now() / 1000 });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    getJobMock.mockReturnValue({ id: 'release-123', project: 'proj', kind: 'release', finishedAt: null });
    listJobsMock.mockReturnValue([
      { id: 'push-failed-1', project: 'proj', kind: 'push', startedAt: 200, finishedAt: 210, exitCode: 1, releaseId: 'release-123' },
    ]);
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0, 'abc1234'));

    const result = await launchProjectPush('proj', { parentJobId: 'release-123' });

    expect(result).toEqual({ jobId: 'proj-push-test-id' });
    await vi.waitFor(() => {
      expect(checkCliStartGateMock).toHaveBeenCalledWith('start a push', { parentJobId: 'release-123' });
      expect(acquireLockMock).not.toHaveBeenCalled();
      expect(markDoneMock).toHaveBeenCalledWith(createJobMock.mock.results[0].value, 0);
    });
  });

  it('launchProjectPush preserves PR creation semantics for a release-linked retry in PR workflow', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'release-123', acquiredAt: Date.now() / 1000 });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    getJobMock.mockReturnValue({ id: 'release-123', project: 'proj', kind: 'release', finishedAt: null });
    listJobsMock.mockReturnValue([
      { id: 'push-failed-1', project: 'proj', kind: 'push', startedAt: 200, finishedAt: 210, exitCode: 1, releaseId: 'release-123' },
    ]);
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))
      .mockImplementationOnce(() => resp(0, '# branch.head feature/release\n# branch.ab +0 -0\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0, 'abc1234'))
      .mockImplementationOnce(() => resp(0, 'feature/release\n')) // decidePrContext
      .mockImplementationOnce(() => resp(0, 'feature/release\n')) // createGenericPR
      .mockImplementationOnce(() => resp(1, '', 'no pull request found'))
      .mockImplementationOnce(() => resp(0, 'https://github.com/acme/widgets/pull/42\n'))
      .mockImplementationOnce(() => resp(0, 'acme/widgets\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0));

    const result = await launchProjectPush('proj', { parentJobId: 'release-123' });

    expect(result).toEqual({ jobId: 'proj-push-test-id' });
    await vi.waitFor(() => {
      expect(checkCliStartGateMock).toHaveBeenCalledWith('start a push', { parentJobId: 'release-123' });
      expect(markDoneMock).toHaveBeenCalledWith(createJobMock.mock.results[0].value, 0);
    });

    const prCreateCall = execMock.mock.calls.find(
      ([cmd, args]) => cmd === 'gh' && Array.isArray(args) && args[0] === 'pr' && args[1] === 'create',
    );
    expect(prCreateCall).toBeTruthy();
    expect(createJobMock.mock.results[0].value.contextMeta).toBe(JSON.stringify({
      prUrl: 'https://github.com/acme/widgets/pull/42',
      prNumber: 42,
      prRepo: 'acme/widgets',
    }));
  });

  it('launchProjectPush still blocks unrelated manual pushes while another release holds the lock', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'release-123', acquiredAt: Date.now() / 1000 });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);

    const result = await launchProjectPush('proj');

    expect(result).toEqual({
      error: 'Pipeline is running for proj — wait for it to finish before pushing manually',
      status: 409,
    });
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('rejects a stale release-linked retry before creating a push job', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'release-active', acquiredAt: Date.now() / 1000 });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    getJobMock.mockReturnValue({ id: 'release-stale', project: 'proj', kind: 'release', finishedAt: Date.now() / 1000 });

    const result = await launchProjectPush('proj', { parentJobId: 'release-stale' });

    expect(result).toEqual({
      error: 'Pipeline is running for proj — wait for it to finish before retrying the push',
      status: 409,
    });
    expect(createJobMock).not.toHaveBeenCalled();
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
  });

  it('launchProjectPush accepts a failed push on the latest finished release', async () => {
    const release = { id: 'release-123', project: 'proj', kind: 'release', startedAt: 100, finishedAt: 300, exitCode: 1 };
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      release,
      { id: 'review-ok', project: 'proj', kind: 'review', startedAt: 150, finishedAt: 160, exitCode: 0, releaseId: 'release-123' },
      { id: 'push-failed-1', project: 'proj', kind: 'push', startedAt: 250, finishedAt: 260, exitCode: 1, releaseId: 'release-123' },
    ]);
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0, 'abc1234'));

    const result = await launchProjectPush('proj', { parentJobId: 'release-123' });

    expect(result).toEqual({ jobId: 'proj-push-test-id' });
    await vi.waitFor(() => {
      expect(checkCliStartGateMock).toHaveBeenCalledWith('start a push', { parentJobId: 'release-123' });
      expect(markDoneMock).toHaveBeenCalledWith(createJobMock.mock.results[0].value, 0);
    });
  });

  it('rejects a release-linked retry when the latest linked step is not a failed push', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'release-123', acquiredAt: Date.now() / 1000 });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    getJobMock.mockReturnValue({ id: 'release-123', project: 'proj', kind: 'release', finishedAt: null });
    listJobsMock.mockReturnValue([
      { id: 'review-running', project: 'proj', kind: 'review', startedAt: 250, finishedAt: null, exitCode: null, releaseId: 'release-123' },
      { id: 'push-failed-older', project: 'proj', kind: 'push', startedAt: 200, finishedAt: 210, exitCode: 1, releaseId: 'release-123' },
    ]);

    const result = await launchProjectPush('proj', { parentJobId: 'release-123' });

    expect(result).toEqual({
      error: 'Release-linked push retry is only allowed when the latest step is a failed push for proj',
      status: 409,
    });
    expect(createJobMock).not.toHaveBeenCalled();
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
  });

  it('stores error string on push failure', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                          // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(1, '', 'remote rejected: permission denied')) // git push
      .mockImplementationOnce(() => resp(0, ''));                            // git status --porcelain (hook changes check → none)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('Push failed');
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Push failed'));
  });

  it('reuses the selected provider when a pre-push hook leaves new changes', async () => {
    checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'codex' });
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n'))
      .mockImplementationOnce(() => resp(1, '', 'hook failed'))
      .mockImplementationOnce(() => resp(0, ' M lint.ts\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, '[master abc123] feat: test\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0, 'abc1234'));

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    expect(generateCommitMessageMock).toHaveBeenCalledWith('/path/to/proj', 'proj', 'codex', expect.anything());
    const hookFixCommitCall = execMock.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args[0] === '-C' && args[2] === 'commit',
    );
    expect(hookFixCommitCall?.[2]).toMatchObject({
      timeout: 30000,
      abortProcessTree: true,
      signal: expect.any(Object),
    });
  });

  it('returns 404 when project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const r = await startProjectPush('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('missing', expect.stringContaining('project not found'));
  });

  it('returns ok with "No changes to push" when not ahead of remote', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '0'))                          // git rev-list --count (not ahead)
      .mockImplementationOnce(() => resp(0, 'abc1234\n'))                  // git rev-parse --short HEAD
      .mockImplementationOnce(() => resp(0, 'master\n'))                   // git branch --show-current (decidePrContext)
      .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/master\n')); // git symbolic-ref (detectMainBranch)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('No changes to push');
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('returns "No changes to push" when no upstream AND repo has no commits (brand-new repo)', async () => {
    execMock
      .mockImplementationOnce(() => resp(1, '', 'fatal: no upstream configured'))  // git rev-list @{u}..HEAD → no upstream
      .mockImplementationOnce(() => resp(0, '0\n'));                              // git rev-list --count HEAD → no commits

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('No changes to push');
  });

  it('proceeds to push when no upstream but repo has commits', async () => {
    execMock
      .mockImplementationOnce(() => resp(1, '', 'fatal: no upstream configured'))  // git rev-list @{u}..HEAD → no upstream
      .mockImplementationOnce(() => resp(0, '3\n'))                               // git rev-list --count HEAD → 3 commits
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                       // git push
      .mockImplementationOnce(() => resp(0, 'abc1234\n'));                         // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    const pushCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('push'),
    );
    expect(pushCall).toBeTruthy();
  });

  it('retries push with -u origin <branch> when "no upstream" error appears', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                      // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(1, '', 'error: The current branch has no upstream branch')) // git push (no upstream)
      .mockImplementationOnce(() => resp(0, 'feature-x'))                               // git branch --show-current
      .mockImplementationOnce(() => resp(0))                                             // git push -u origin feature-x
      .mockImplementationOnce(() => resp(0, 'abc1234'));                                 // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    const upstreamPush = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('-u')
    );
    expect(upstreamPush).toBeTruthy();
  });

  it('reports push failure when upstream retry also fails', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                       // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(1, '', 'error: no upstream branch'))             // git push (no upstream)
      .mockImplementationOnce(() => resp(0, 'feature-x'))                                // git branch --show-current
      .mockImplementationOnce(() => resp(1, '', 'remote: permission denied'))            // git push -u (fails)
      .mockImplementationOnce(() => resp(0, ''));                                        // git status --porcelain (no hook changes)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.detail).toContain('Push failed');
    }
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', expect.stringContaining('Push failed'));
  });

  it('does not rebase a generic remote rejection from the set-upstream retry', async () => {
    execMock
      .mockImplementationOnce(() => resp(1, '', 'fatal: no upstream configured'))          // git rev-list @{u}..HEAD → no upstream
      .mockImplementationOnce(() => resp(0, '3\n'))                                       // git rev-list --count HEAD
      .mockImplementationOnce(() => resp(0, '# branch.head feature-x\n'))                 // behind check
      .mockImplementationOnce(() => resp(1, '', 'error: no upstream branch'))             // git push (no upstream)
      .mockImplementationOnce(() => resp(0, 'feature-x'))                                // git branch --show-current
      .mockImplementationOnce(() => resp(1, '', '! [remote rejected] feature-x -> feature-x (protected branch hook declined)')) // git push -u (server rejection)
      .mockImplementationOnce(() => resp(0, ''));                                        // git status --porcelain (no hook changes)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.detail).toContain('Push failed');
      expect(r.detail).toContain('protected branch hook declined');
    }
    const rebaseCalls = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && args.includes('pull') && args.includes('--rebase'),
    );
    expect(rebaseCalls).toHaveLength(0);
  });

  it('rebases with an explicit origin branch when the set-upstream retry hits a ref race', async () => {
    execMock
      .mockImplementationOnce(() => resp(1, '', 'fatal: no upstream configured'))          // git rev-list @{u}..HEAD → no upstream
      .mockImplementationOnce(() => resp(0, '3\n'))                                       // git rev-list --count HEAD
      .mockImplementationOnce(() => resp(0, '# branch.head feature-x\n'))                 // behind check
      .mockImplementationOnce(() => resp(1, '', 'error: no upstream branch'))             // git push (no upstream)
      .mockImplementationOnce(() => resp(0, 'feature-x'))                                // git branch --show-current
      .mockImplementationOnce(() => resp(1, '', "remote: error: cannot lock ref 'refs/heads/feature-x': is at aaa but expected bbb\n! [remote rejected] feature-x -> feature-x (failed to update ref)")) // git push -u (ref race)
      .mockImplementationOnce(() => resp(0))                                             // git pull --rebase origin feature-x
      .mockImplementationOnce(() => resp(0))                                             // git push -u origin feature-x
      .mockImplementationOnce(() => resp(0, 'abc1234'));                                 // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    const rebaseCall = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('pull') && args.includes('--rebase'),
    );
    expect(rebaseCall?.[1]).toEqual(['-C', '/path/to/proj', 'pull', '--rebase', 'origin', 'feature-x']);
    const upstreamPushes = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && args.includes('push') && args.includes('-u') && args.includes('feature-x'),
    );
    expect(upstreamPushes).toHaveLength(2);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('stages and commits hook-left changes then retries push when pre-push hook leaves new files', async () => {
    generateCommitMessageMock.mockResolvedValue('chore: apply lint fixes');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                              // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(1, '', 'pre-push hook: lint failed'))   // git push (pre-push hook fails)
      .mockImplementationOnce(() => resp(0, 'M\t.lint-cache\n'))                 // git status --porcelain (hook left changes)
      .mockImplementationOnce(() => resp(0))                                     // git add -u (stage tracked hook changes)
      .mockImplementationOnce(() => resp(0, ''))                                 // git ls-files --others
      .mockImplementationOnce(() => resp(0))                                     // git commit (fix commit)
      .mockImplementationOnce(() => resp(0))                                     // git push (retry — succeeds)
      .mockImplementationOnce(() => resp(0, 'def5678'));                         // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    // Verify the fix commit was made
    const fixCommit = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('commit') && args.includes('chore: apply lint fixes')
    );
    expect(fixCommit).toBeTruthy();
    const addCalls = execMock.mock.calls
      .filter(([cmd, args]: any) => cmd === 'git' && args.includes('add'))
      .map(([, args]: any) => args);
    expect(addCalls).toContainEqual(['-C', '/path/to/proj', 'add', '-u', '--', '.']);
    expect(addCalls.flat()).not.toContain('-A');
  });

  it('does not throw when setProjectPushResult throws', async () => {
    setProjectPushResultMock.mockImplementation(() => { throw new Error('DB locked'); });
    execMock
      .mockImplementationOnce(() => resp(0, '0'))                          // git rev-list --count (not ahead)
      .mockImplementationOnce(() => resp(0, 'abc1234\n'))                  // git rev-parse --short HEAD
      .mockImplementationOnce(() => resp(0, 'master\n'))                   // git branch --show-current (decidePrContext)
      .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/master\n')); // git symbolic-ref (detectMainBranch)

    await expect(startProjectPush('proj')).resolves.not.toThrow();
  });

  it('creates a tracked "push" job and marks it done with exit 0 on success', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                          // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                 // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));                     // git rev-parse

    await startProjectPush('proj');
    expect(createJobMock).toHaveBeenCalled();
    const [cjProject, cjKind, cjPid, cjLog] = createJobMock.mock.calls[0];
    expect(cjProject).toBe('proj');
    expect(cjKind).toBe('push');
    expect(cjPid).toEqual(expect.any(Number));
    expect(cjLog).toBe('');
    const job = createJobMock.mock.results[0].value;
    expect(job.logPath).toMatch(/\.log$/);
    expect(markDoneMock).toHaveBeenCalledWith(job, 0);
  });

  it('creates a tracked "push" job and marks it done with exit 1 on push failure', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                          // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(1, '', 'permission denied'))        // git push
      .mockImplementationOnce(() => resp(0, ''));                            // git status --porcelain (no hook changes)

    await startProjectPush('proj');
    expect(createJobMock).toHaveBeenCalled();
    const job = createJobMock.mock.results[0].value;
    expect(markDoneMock).toHaveBeenCalledWith(job, 1);
  });

  it('rebases and retries when push is rejected with "fetch first" (stale tracking info)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.ab +1 -0\n'))          // git status --porcelain=v2 --branch (behind=0)
      .mockImplementationOnce(() => resp(1, '', 'error: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: \'git pull\' before pushing again.')) // git push → fetch first
      .mockImplementationOnce(() => resp(0))                                  // git pull --rebase
      .mockImplementationOnce(() => resp(0))                                  // git push (retry)
      .mockImplementationOnce(() => resp(0, 'abc1234'));                      // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    const rebaseCalls = execMock.mock.calls.filter(
      ([cmd, args]: any) => cmd === 'git' && args.includes('pull') && args.includes('--rebase')
    );
    expect(rebaseCalls.length).toBe(1);
    expect(setProjectPushResultMock).toHaveBeenCalledWith('proj', null);
  });

  it('rebases and retries when push is rejected with "fetch first" message variant', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.ab +1 -0\n'))          // behind check (shows 0 behind)
      .mockImplementationOnce(() => resp(1, '', '! [rejected] master -> master (fetch first)')) // git push
      .mockImplementationOnce(() => resp(0))                                  // git pull --rebase
      .mockImplementationOnce(() => resp(0))                                  // git push (retry)
      .mockImplementationOnce(() => resp(0, 'def5678'));                      // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
  });

  it('pauses the project when the rebase after a "fetch first" rejection hits a merge conflict', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.ab +1 -0\n'))          // behind check
      .mockImplementationOnce(() => resp(1, '', 'Updates were rejected because the remote contains work'))  // git push
      .mockImplementationOnce(() => resp(1, '', 'CONFLICT: merge conflict in foo.ts')) // git pull --rebase fails
      .mockImplementationOnce(() => resp(0));                                 // git rebase --abort

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('Merge conflict');
      expect(r.detail).toContain('paused');
    }
    // Aborted the half-finished rebase so the worktree is left clean.
    const abortCall = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('rebase') && args.includes('--abort'),
    );
    expect(abortCall).toBeTruthy();
    // Paused the project so the scheduler stops retrying a doomed push, with a
    // HITL reason telling the operator to resolve the conflict locally.
    expect(pauseProjectMock).toHaveBeenCalledWith('proj', expect.stringContaining('locally, then resume.'));
  });

  it('pauses the project when the pre-push behind-rebase hits a merge conflict', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                 // git rev-list --count (ahead)
      .mockImplementationOnce(() => resp(0, '# branch.head main\n# branch.ab +0 -3\n')) // behind check → 3 behind
      .mockImplementationOnce(() => resp(1, '', 'CONFLICT (content): Merge conflict in app.ts')) // git pull --rebase fails
      .mockImplementationOnce(() => resp(0));                                       // git rebase --abort

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('Merge conflict');
      expect(r.detail).toContain('paused');
    }
    expect(pauseProjectMock).toHaveBeenCalledWith('proj', expect.stringContaining('locally, then resume.'));
    // No push should be attempted once the pull/rebase conflicts.
    const pushCall = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('push'),
    );
    expect(pushCall).toBeFalsy();
  });

  it('does NOT pause the project when the rebase fails for a non-conflict reason', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                 // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head main\n# branch.ab +0 -2\n')) // behind check → 2 behind
      .mockImplementationOnce(() => resp(1, '', 'error: cannot open .git/FETCH_HEAD: Operation not permitted')); // git pull --rebase fails (env, not conflict)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('Rebase failed before push');
    }
    // Environmental failure must NOT abort+pause — it should retry next cycle.
    expect(pauseProjectMock).not.toHaveBeenCalled();
    const abortCall = execMock.mock.calls.find(
      ([cmd, args]: any) => cmd === 'git' && args.includes('rebase') && args.includes('--abort'),
    );
    expect(abortCall).toBeFalsy();
  });

  it('does not create a push job when project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    await startProjectPush('missing');
    expect(createJobMock).not.toHaveBeenCalled();
    expect(markDoneMock).not.toHaveBeenCalled();
  });

  it('returns 409 with blockingJobId when pipeline lock is held by another job', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'blocking-job-99', acquiredAt: Date.now() / 1000 });
    acquireLockMock.mockResolvedValue({ acquired: false, lock: {}, blockingJobId: 'blocking-job-99' });
    isLockOwnedByActiveReleaseMock.mockReturnValue(false);

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.blockingJobId).toBe('blocking-job-99');
    }
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('skips lock check and proceeds when isLockOwnedByActiveRelease returns true', async () => {
    getLockMock.mockReturnValue({ project: 'proj', lockedByJobId: 'release-job', acquiredAt: Date.now() / 1000 });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);

    execMock
      .mockImplementationOnce(() => resp(0, '0'))                          // git rev-list --count (not ahead)
      .mockImplementationOnce(() => resp(0, 'abc1234\n'))                  // git rev-parse --short HEAD
      .mockImplementationOnce(() => resp(0, 'master\n'))                   // git branch --show-current (decidePrContext)
      .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/master\n')); // git symbolic-ref (detectMainBranch)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('No changes to push');
  });
});
