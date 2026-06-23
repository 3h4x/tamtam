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
import { startProjectPush } from '@/lib/pipeline/start-push';

describe('startProjectPush — PR creation', () => {
  const {
    execMock, getProjectTestConfigMock, listJobsMock,
    findIssueContextMock, generateCommitMessageMock, deriveIssueContextFromBranchMock,
  } = mocks;

  beforeEach(() => {
    resetSharedMocks();
  });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

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
      .mockImplementationOnce(() => resp(0, JSON.stringify({ url: existingUrl, state: 'OPEN' }))) // gh pr view (existing PR)
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
