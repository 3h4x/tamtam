import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted shared mock factories for the bulk of tests in this file.
// Mocking at module scope (rather than vi.doMock + vi.resetModules in
// each beforeEach) lets every test reuse the same compiled module graph
// for start-push and its deps, which is much faster than rebuilding the
// graph per test.
const mocks = vi.hoisted(() => {
  const execMock = vi.fn();
  const setProjectPushResultMock = vi.fn();
  const createJobMock = vi.fn();
  const markDoneMock = vi.fn();
  const updateJobMock = vi.fn();
  const generateCommitMessageMock = vi.fn();
  const findIssueContextMock = vi.fn();
  const detectMainBranchMock = vi.fn();
  const issueBranchNameMock = vi.fn();
  const deriveIssueContextFromBranchMock = vi.fn();
  const checkCliStartGateMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  const getLockMock = vi.fn();
  const acquireLockMock = vi.fn();
  const isLockOwnedByActiveReleaseMock = vi.fn();
  const getJobMock = vi.fn();
  const listJobsMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  const clearProjectDataCacheMock = vi.fn();
  const invalidateProjectMock = vi.fn();
  const mkdirSyncMock = vi.fn();
  const appendFileSyncMock = vi.fn();
  const currentParentMock = vi.fn();
  return {
    execMock, setProjectPushResultMock, createJobMock, markDoneMock,
    updateJobMock, generateCommitMessageMock, findIssueContextMock,
    detectMainBranchMock, issueBranchNameMock, deriveIssueContextFromBranchMock,
    checkCliStartGateMock, getProjectTestConfigMock, getLockMock,
    acquireLockMock, isLockOwnedByActiveReleaseMock, getJobMock, listJobsMock,
    resolveProjectPathMock, clearProjectDataCacheMock, invalidateProjectMock,
    mkdirSyncMock, appendFileSyncMock, currentParentMock,
  };
});

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
  pushCurrentBranch,
  validateReleaseLinkedCommitRetry,
} from '@/lib/pipeline/start-push';

function defaultCreateJob(project: string, kind: string, pid: number, logPath: string) {
  return {
    id: `${project}-${kind}-test-id`, project, kind, pid, logPath, prompt: null,
    startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    durationMs: null, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    contextMeta: null, userPrompt: null,
  };
}

function resetSharedMocks() {
  for (const m of Object.values(mocks)) {
    m.mockReset();
  }
  // Per-test baseline defaults — same as the original beforeEach.
  mocks.resolveProjectPathMock.mockReturnValue('/path/to/proj');
  mocks.createJobMock.mockImplementation(defaultCreateJob);
  mocks.markDoneMock.mockResolvedValue(undefined);
  mocks.generateCommitMessageMock.mockResolvedValue('feat: test');
  mocks.checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'claude' });
  mocks.getProjectTestConfigMock.mockReturnValue(null);
  mocks.getLockMock.mockReturnValue(null);
  mocks.acquireLockMock.mockResolvedValue({
    acquired: true,
    lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 },
  });
  mocks.isLockOwnedByActiveReleaseMock.mockReturnValue(false);
  mocks.getJobMock.mockReturnValue(null);
  mocks.listJobsMock.mockReturnValue([]);
  mocks.findIssueContextMock.mockResolvedValue(null);
  mocks.detectMainBranchMock.mockResolvedValue('main');
  mocks.issueBranchNameMock.mockReturnValue('fix/issue-1-test');
  mocks.deriveIssueContextFromBranchMock.mockResolvedValue(null);
  mocks.currentParentMock.mockReturnValue(null);
}

describe('startProjectPush — push result tracking', () => {
  const {
    execMock, setProjectPushResultMock, createJobMock, markDoneMock,
    generateCommitMessageMock, checkCliStartGateMock, getProjectTestConfigMock,
    getLockMock, acquireLockMock, isLockOwnedByActiveReleaseMock,
    getJobMock, listJobsMock, resolveProjectPathMock,
    findIssueContextMock, deriveIssueContextFromBranchMock,
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
      error: 'Release-linked push retry is only allowed for the active release on proj',
      status: 409,
    });
    expect(createJobMock).not.toHaveBeenCalled();
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
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

  it('stages and commits hook-left changes then retries push when pre-push hook leaves new files', async () => {
    generateCommitMessageMock.mockResolvedValue('chore: apply lint fixes');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                              // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(1, '', 'pre-push hook: lint failed'))   // git push (pre-push hook fails)
      .mockImplementationOnce(() => resp(0, 'M\t.lint-cache\n'))                 // git status --porcelain (hook left changes)
      .mockImplementationOnce(() => resp(0))                                     // git add -A (stage hook changes)
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

  it('returns 409 when rebase fails after "fetch first" rejection', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.ab +1 -0\n'))          // behind check
      .mockImplementationOnce(() => resp(1, '', 'Updates were rejected because the remote contains work'))  // git push
      .mockImplementationOnce(() => resp(1, '', 'CONFLICT: merge conflict in foo.ts')); // git pull --rebase fails

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('Rebase failed');
    }
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

  it('creates a PR when the most recent run job has a ghIssueNumber, prWorkflowEnabled, and push succeeds', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });
    listJobsMock.mockReturnValue([{
      id: 'run-job-1', project: 'proj', kind: 'run', startedAt: Date.now() / 1000,
      ghIssueNumber: 42, ghIssueRepo: 'owner/repo', ghIssueTitle: 'Fix login bug',
    }]);
    findIssueContextMock.mockResolvedValue({ number: 42, repo: 'owner/repo', title: 'Fix login bug' });
    mocks.issueBranchNameMock.mockReturnValue('fix/issue-42-fix-login-bug');
    generateCommitMessageMock.mockResolvedValue('fix: login bug');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                              // git rev-list --count @{u}..HEAD
      .mockImplementationOnce(() => resp(0, '# branch.head fix/issue-42-fix-login-bug\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                     // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                          // git rev-parse
      .mockImplementationOnce(() => resp(0, 'fix/issue-42-fix-login-bug'))       // git branch --show-current (in createIssuePR)
      .mockImplementationOnce(() => resp(0, '[]'))                               // gh pr list --head ... (no existing PR)
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/pull/99\n')) // gh pr create
      .mockImplementationOnce(() => resp(0))                                     // git checkout main
      .mockImplementationOnce(() => resp(0));                                    // git pull --ff-only origin main

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('PR created');
      expect(r.message).toContain('https://github.com/owner/repo/pull/99');
    }
    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeTruthy();
  });

  it('skips PR creation when one already exists for the current branch (Push to PR flow)', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });
    listJobsMock.mockReturnValue([{
      id: 'run-1', project: 'proj', kind: 'run', startedAt: Date.now() / 1000,
      ghIssueNumber: 42, ghIssueRepo: 'owner/repo', ghIssueTitle: 'Fix login bug',
    }]);
    findIssueContextMock.mockResolvedValue({ number: 42, repo: 'owner/repo', title: 'Fix login bug' });
    mocks.issueBranchNameMock.mockReturnValue('fix/issue-42-fix-login-bug');
    generateCommitMessageMock.mockResolvedValue('fix: login bug');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))
      .mockImplementationOnce(() => resp(0, '# branch.head fix/issue-42-fix-login-bug\n# branch.ab +0 -0\n'))
      .mockImplementationOnce(() => resp(0))
      .mockImplementationOnce(() => resp(0, 'abc1234'))
      .mockImplementationOnce(() => resp(0, 'fix/issue-42-fix-login-bug'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ url: 'https://github.com/owner/repo/pull/77' }]))) // gh pr list — already exists
      .mockImplementationOnce(() => resp(0))                                     // git checkout main
      .mockImplementationOnce(() => resp(0));                                    // git pull

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('PR created');
      expect(r.prUrl).toBe('https://github.com/owner/repo/pull/77');
    }
    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeUndefined();
  });

  it('does NOT create a PR when the linked issue is already CLOSED', async () => {
    listJobsMock.mockReturnValue([{
      id: 'run-job-stale', project: 'proj', kind: 'run', startedAt: Date.now() / 1000,
      ghIssueNumber: 7, ghIssueRepo: 'owner/repo', ghIssueTitle: 'Already shipped',
    }]);
    // findIssueContext returns null (issue is closed)
    findIssueContextMock.mockResolvedValue(null);
    mocks.issueBranchNameMock.mockReturnValue('fix/issue-7-already-shipped');
    generateCommitMessageMock.mockResolvedValue('feat: add');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                  // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));                      // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('pushed'); // plain message, NOT "PR created"

    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeUndefined();
  });

  it('falls back to deriveIssueContextFromBranch when findIssueContext returns null', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });
    // findIssueContext returns null (recency window expired), but branch reveals the issue
    findIssueContextMock.mockResolvedValue(null);
    deriveIssueContextFromBranchMock.mockResolvedValue({ number: 33, repo: 'owner/repo', title: 'Stale context fix' });
    mocks.issueBranchNameMock.mockReturnValue('fix/issue-33-stale-context');
    generateCommitMessageMock.mockResolvedValue('fix: stale context');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                                      // rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head fix/issue-33-stale-context\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                                             // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                                                  // git rev-parse
      .mockImplementationOnce(() => resp(0, 'fix/issue-33-stale-context'))                               // branch --show-current inside createIssuePR
      .mockImplementationOnce(() => resp(0, '[]'))                                                       // gh pr list — no existing PR
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/pull/33\n'))                  // gh pr create
      .mockImplementationOnce(() => resp(0))                                                             // git checkout main
      .mockImplementationOnce(() => resp(0));                                                            // git pull --ff-only

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('PR created');
      expect(r.message).toContain('https://github.com/owner/repo/pull/33');
    }
    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeTruthy();
  });

  it('creates a PR for an issue-linked push even when prWorkflowEnabled is off (Work-on opt-in)', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false, autoPrMergeEnabled: false });
    listJobsMock.mockReturnValue([{
      id: 'run-job-issue', project: 'proj', kind: 'run', startedAt: Date.now() / 1000,
      ghIssueNumber: 42, ghIssueRepo: 'owner/repo', ghIssueTitle: 'Fix login bug',
    }]);
    findIssueContextMock.mockResolvedValue({ number: 42, repo: 'owner/repo', title: 'Fix login bug' });
    mocks.issueBranchNameMock.mockReturnValue('fix/issue-42-fix-login-bug');
    generateCommitMessageMock.mockResolvedValue('fix: login bug');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                                     // rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head fix/issue-42-fix-login-bug\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                                            // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                                                 // git rev-parse
      .mockImplementationOnce(() => resp(0, 'fix/issue-42-fix-login-bug'))                              // branch --show-current inside createIssuePR
      .mockImplementationOnce(() => resp(0, '[]'))                                                      // gh pr list — no existing PR
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/pull/77\n'))                // gh pr create
      .mockImplementationOnce(() => resp(0))                                                            // checkout main (post-PR cleanup)
      .mockImplementationOnce(() => resp(0));                                                           // pull origin main

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('PR created');
      expect(r.prUrl).toBe('https://github.com/owner/repo/pull/77');
    }
    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeTruthy();
    // Even with auto-merge off, do NOT switch back to main: the user keeps
    // iterating on the issue branch until the PR is merged.
    const checkoutMain = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('checkout') && args.includes('main'),
    );
    expect(checkoutMain).toBeUndefined();
  });

  it('returns ok with plain "pushed" message when no issue context exists', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                           // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head master\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                  // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'));                      // git rev-parse

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('pushed');
  });

  it('leaves the current branch alone when pushing a non-issue fix branch without issue context', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false });
    mocks.issueBranchNameMock.mockReturnValue('fix/issue-45-test');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                        // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head fix/issue-45-test\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                               // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                                   // git rev-parse
      .mockImplementationOnce(() => resp(0, 'fix/issue-45-test\n'));                      // git branch --show-current

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);

    const checkoutCall = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('checkout') && args.includes('main'),
    );
    expect(checkoutCall).toBeUndefined();
  });

  it('creates a generic PR when pushing a non-default feature branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true, autoPrMergeEnabled: false });

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                               // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head feat/x\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                       // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                            // git rev-parse
      .mockImplementationOnce(() => resp(0, 'feat/my-feature'))                    // git branch --show-current (decidePrContext)
      .mockImplementationOnce(() => resp(0, 'feat/my-feature'))                    // git branch --show-current (createGenericPR)
      .mockImplementationOnce(() => resp(1, '', 'no pr'))                          // gh pr view (no existing PR)
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/pull/42\n')) // gh pr create
      .mockImplementationOnce(() => resp(0, 'owner/repo'));                        // gh repo view

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('PR created');
      expect(r.message).toContain('https://github.com/owner/repo/pull/42');
      expect(r.prNumber).toBe(42);
      expect(r.prRepo).toBe('owner/repo');
    }
    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeTruthy();
    // Stay on the feature branch — auto-merge off does NOT mean switch back.
    const checkoutMain = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('checkout') && args.includes('main'),
    );
    expect(checkoutMain).toBeUndefined();
  });

  it('returns existing PR url without creating a new one on a non-default feature branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true, autoPrMergeEnabled: false });

    const existingUrl = 'https://github.com/owner/repo/pull/7';
    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                               // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head feat/x\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                       // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                            // git rev-parse
      .mockImplementationOnce(() => resp(0, 'feat/my-feature'))                    // git branch --show-current (decidePrContext)
      .mockImplementationOnce(() => resp(0, 'feat/my-feature'))                    // git branch --show-current (createGenericPR)
      .mockImplementationOnce(() => resp(0, JSON.stringify({ url: existingUrl }))) // gh pr view (existing PR)
      .mockImplementationOnce(() => resp(0, 'owner/repo'));                        // gh repo view

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain(existingUrl);
      expect(r.prNumber).toBe(7);
    }
    // Must stay on the feature branch even when reusing an existing PR.
    const checkoutMain = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('checkout') && args.includes('main'),
    );
    expect(checkoutMain).toBeUndefined();
    // Must NOT call gh pr create since one already exists
    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeUndefined();
  });

  it('returns "pushed (PR creation failed)" when generic PR creation fails on a feature branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                               // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head feat/x\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                       // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                            // git rev-parse
      .mockImplementationOnce(() => resp(0, 'feat/my-feature'))                    // git branch --show-current (decidePrContext)
      .mockImplementationOnce(() => resp(0, 'feat/my-feature'))                    // git branch --show-current (createGenericPR)
      .mockImplementationOnce(() => resp(1, '', 'no pr'))                          // gh pr view (no existing PR)
      .mockImplementationOnce(() => resp(1, '', 'pr create failed'));              // gh pr create fails

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toContain('PR creation failed');
  });

  it('skips PR creation when prWorkflowEnabled but currently on the default branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                               // git rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head main\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                       // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                            // git rev-parse
      .mockImplementationOnce(() => resp(0, 'main'));                              // git branch --show-current (=main → skips PR)

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('pushed');
    const prCreateCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('create'));
    expect(prCreateCall).toBeUndefined();
  });

  it('does NOT checkout main after creating an issue PR when auto-merge is on — stays on the issue branch until pr-wait merges it', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true, autoPrMergeEnabled: true });
    listJobsMock.mockReturnValue([{
      id: 'run-1', project: 'proj', kind: 'run', startedAt: Date.now() / 1000,
      ghIssueNumber: 25, ghIssueRepo: 'owner/repo', ghIssueTitle: 'feat(stake): real per-chain liquidity',
    }]);
    findIssueContextMock.mockResolvedValue({ number: 25, repo: 'owner/repo', title: 'feat(stake)' });
    mocks.issueBranchNameMock.mockReturnValue('fix/issue-25-real-liquidity');
    generateCommitMessageMock.mockResolvedValue('feat: real liquidity');

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                              // rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head fix/issue-25\n# branch.ab +0 -0\n')) // behind check
      .mockImplementationOnce(() => resp(0))                                                     // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                                          // rev-parse
      .mockImplementationOnce(() => resp(0, 'fix/issue-25-real-liquidity'))                      // branch --show-current in createIssuePR
      .mockImplementationOnce(() => resp(0, '[]'))                                                // gh pr list (none)
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/pull/25\n'));         // gh pr create

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prUrl).toBe('https://github.com/owner/repo/pull/25');

    const checkoutMain = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('checkout') && args.includes('main'),
    );
    expect(checkoutMain).toBeUndefined();
    const pullMain = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('pull') && args.includes('--ff-only'),
    );
    expect(pullMain).toBeUndefined();
  });

  it('does NOT checkout main after creating a generic PR when auto-merge is on — stays on feature branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true, autoPrMergeEnabled: true });

    execMock
      .mockImplementationOnce(() => resp(0, '1\n'))                                                  // rev-list --count
      .mockImplementationOnce(() => resp(0, '# branch.head feat/x\n# branch.ab +0 -0\n'))            // behind check
      .mockImplementationOnce(() => resp(0))                                                         // git push
      .mockImplementationOnce(() => resp(0, 'abc1234'))                                              // rev-parse
      .mockImplementationOnce(() => resp(0, 'feat/my-feature'))                                      // branch --show-current
      .mockImplementationOnce(() => resp(1, '', 'no pr'))                                            // gh pr view (no PR)
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/pull/42\n'))              // gh pr create
      .mockImplementationOnce(() => resp(0, 'owner/repo'));                                          // gh repo view

    const r = await startProjectPush('proj');
    expect(r.ok).toBe(true);

    const checkoutMain = (execMock.mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === 'git' && args.includes('checkout') && args.includes('main'),
    );
    expect(checkoutMain).toBeUndefined();
  });
});

// ─── generateCommitMessage ────────────────────────────────────────────────────
//
// These tests need the *real* start-commit module (the rest of this file
// mocks it). We `vi.doUnmock` it and rebuild the module graph per test so
// the real implementation is loaded with our local mocks for its deps.
// This is the same pattern the original file used; it's the slowest block
// but only ~16 tests, and the alternative (extracting to a separate file)
// would create more I/O than it would save.

describe('generateCommitMessage', () => {
  let generateCommitMessage: typeof import('@/lib/pipeline/start-commit').generateCommitMessage;
  let execMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(async () => {
    vi.resetModules();
    // Ensure @/lib/pipeline/start-commit is NOT mocked so we test the real implementation.
    vi.doUnmock('@/lib/pipeline/start-commit');
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ commit_style: '' }),
      getPipelineModel: () => 'haiku',
      getPermissionModeFlag: () => '',
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
      getJob: vi.fn(() => null),
      createJob: vi.fn(),
      markDone: vi.fn(),
      updateJob: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: () => null,
    }));
    ({ generateCommitMessage } = await import('@/lib/pipeline/start-commit'));
  });

  afterEach(() => { vi.resetModules(); });

  it('passes --tools "" and --system-prompt to claude to prevent tool use and CLAUDE.md injection', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'file.ts | 1 +'))    // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'diff --git a/file.ts')) // git diff --cached
      .mockImplementationOnce(() => resp(0, 'feat: add feature')); // claude

    await generateCommitMessage('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    expect(claudeCall).toBeTruthy();
    const args: string[] = claudeCall![1];
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('--print');
  });

  it('returns the commit message from a single-line claude response', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'fix(auth): correct token expiry logic'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('fix(auth): correct token expiry logic');
  });

  it('extracts conventional title from multiline response that includes prose', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'Here is the commit title:\n\nfeat(api): add rate limiting middleware'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('feat(api): add rate limiting middleware');
  });

  it('retries when first response matches generic GENERIC_RE pattern', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))                              // git diff --stat
      .mockImplementationOnce(() => resp(0, ''))                              // git diff
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))       // first claude → generic
      .mockImplementationOnce(() => resp(0, 'refactor(push): improve retry logic')); // retry claude

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('refactor(push): improve retry logic');
    const claudeCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'claude');
    expect(claudeCalls).toHaveLength(2);
  });

  it('retries when first response is "chore: update" (bare generic)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: update'))
      .mockImplementationOnce(() => resp(0, 'test(lib): add coverage for push helper'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('test(lib): add coverage for push helper');
  });

  it('retries when first response is empty', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))                              // empty first attempt
      .mockImplementationOnce(() => resp(0, 'chore(deps): bump dependencies'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore(deps): bump dependencies');
  });

  it('returns fallback when both attempts produce no usable output', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))   // first attempt: empty
      .mockImplementationOnce(() => resp(0, ''));  // retry: also empty

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update files');
  });

  it('does not return msg2 when it is also a generic placeholder', async () => {
    // msg1 is empty (triggers retry); msg2 is a generic placeholder.
    // Old behavior: returned msg2 because it was truthy.
    // New behavior: generic msg2 is filtered, falls through to 'chore: update files'.
    execMock
      .mockImplementationOnce(() => resp(0, ''))   // git diff --stat (no files)
      .mockImplementationOnce(() => resp(0, ''))   // git diff (no content)
      .mockImplementationOnce(() => resp(0, ''))   // first claude attempt: empty
      .mockImplementationOnce(() => resp(0, 'chore: update'));  // retry: generic

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).not.toBe('chore: update');
    expect(msg).toBe('chore: update files');
  });

  it('derives chore:update <files> from stat when both claude attempts are generic', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'lib/foo.ts | 3 +++\nlib/bar.ts | 1 -\n 2 files changed'))
      .mockImplementationOnce(() => resp(0, 'diff --git a/lib/foo.ts'))
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))  // first: generic
      .mockImplementationOnce(() => resp(0, 'chore: update'));           // retry: generic

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update lib/foo.ts, lib/bar.ts');
  });

  it('caps file-name fallback at 3 files', async () => {
    const stat = ['a.ts | 1', 'b.ts | 1', 'c.ts | 1', 'd.ts | 1'].join('\n');
    execMock
      .mockImplementationOnce(() => resp(0, stat))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))
      .mockImplementationOnce(() => resp(0, 'chore: update'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update a.ts, b.ts, c.ts');
  });

  it('does not retry when first response is a specific conventional commit (not generic)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore(ci): update workflow permissions'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore(ci): update workflow permissions');
    const claudeCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'claude');
    expect(claudeCalls).toHaveLength(1);
  });

  it('prefers specific conventional line over generic one when both are in output', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: automated update\nfeat(push): add stale-tracking rebase\nchore: update'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('feat(push): add stale-tracking rebase');
  });

  it('includes style guide in prompt when commit_style is set', async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/pipeline/start-commit');
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ commit_style: 'Always include a ticket number like PROJ-123.' }),
      getPipelineModel: () => 'haiku',
      getPermissionModeFlag: () => '',
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
      getJob: vi.fn(() => null),
      createJob: vi.fn(),
      markDone: vi.fn(),
      updateJob: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: () => null,
    }));
    const { generateCommitMessage: fn } = await import('@/lib/pipeline/start-commit');

    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'feat: add something'));

    await fn('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    const prompt: string = claudeCall![1][claudeCall![1].indexOf('-p') + 1];
    expect(prompt).toContain('STYLE GUIDE');
    expect(prompt).toContain('Always include a ticket number');
  });

  it('includes diff context (stat + patch) in the prompt', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'lib/foo.ts | 5 +++++'))        // git diff --stat
      .mockImplementationOnce(() => resp(0, 'diff --git a/lib/foo.ts\n+const x = 1;')) // git diff
      .mockImplementationOnce(() => resp(0, 'feat: add foo'));

    await generateCommitMessage('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    const prompt: string = claudeCall![1][claudeCall![1].indexOf('-p') + 1];
    expect(prompt).toContain('lib/foo.ts');
    expect(prompt).toContain('myrepo');
  });
});

describe('launchProjectPush — fire-and-forget', () => {
  const {
    execMock, createJobMock, updateJobMock, markDoneMock,
    mkdirSyncMock, appendFileSyncMock,
    getLockMock, acquireLockMock, resolveProjectPathMock,
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
