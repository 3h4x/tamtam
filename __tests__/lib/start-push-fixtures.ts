import { vi } from 'vitest';

// Shared mock factories + reset helper for the start-push test suite.
//
// The module-scope `vi.mock(...)` declarations live in each sibling test file
// (Vitest hoists `vi.mock` per file, so they cannot be moved into a helper),
// but every one of them references this single shared `mocks` object. Mocking
// at module scope (rather than `vi.doMock` + `vi.resetModules` per test) lets
// every test reuse the same compiled module graph for start-push and its deps,
// which is much faster than rebuilding the graph per test.
export const mocks = {
  execMock: vi.fn(),
  setProjectPushResultMock: vi.fn(),
  createJobMock: vi.fn(),
  markDoneMock: vi.fn(),
  updateJobMock: vi.fn(),
  generateCommitMessageMock: vi.fn(),
  stageProjectChangesMock: vi.fn(),
  findIssueContextMock: vi.fn(),
  detectMainBranchMock: vi.fn(),
  issueBranchNameMock: vi.fn(),
  deriveIssueContextFromBranchMock: vi.fn(),
  checkCliStartGateMock: vi.fn(),
  getProjectTestConfigMock: vi.fn(),
  getLockMock: vi.fn(),
  acquireLockMock: vi.fn(),
  isLockOwnedByActiveReleaseMock: vi.fn(),
  getJobMock: vi.fn(),
  listJobsMock: vi.fn(),
  resolveProjectPathMock: vi.fn(),
  clearProjectDataCacheMock: vi.fn(),
  invalidateProjectMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  appendFileSyncMock: vi.fn(),
  currentParentMock: vi.fn(),
  pauseProjectMock: vi.fn(),
};

export function defaultCreateJob(project: string, kind: string, pid: number, logPath: string) {
  return {
    id: `${project}-${kind}-test-id`, project, kind, pid, logPath, prompt: null,
    startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    durationMs: null, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    contextMeta: null, userPrompt: null,
  };
}

export function resetSharedMocks() {
  for (const m of Object.values(mocks)) {
    m.mockReset();
  }
  // Per-test baseline defaults — same as the original beforeEach.
  mocks.resolveProjectPathMock.mockReturnValue('/path/to/proj');
  mocks.createJobMock.mockImplementation(defaultCreateJob);
  mocks.markDoneMock.mockResolvedValue(undefined);
  mocks.generateCommitMessageMock.mockResolvedValue('feat: test');
  mocks.stageProjectChangesMock.mockImplementation(async (projPath, execStep) => {
    const trackedR = await execStep('git', ['-C', projPath, 'add', '-u', '--', '.'], { timeout: 10000 });
    if (trackedR.exitCode !== 0) return trackedR;
    const untrackedR = await execStep('git', ['-C', projPath, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 10000 });
    if (untrackedR.exitCode !== 0) return untrackedR;
    const untracked = String(untrackedR.stdout || '').split('\0').filter(Boolean).filter(path => path !== '.tamtam/cache' && !path.startsWith('.tamtam/cache/'));
    if (untracked.length === 0) return { exitCode: 0, stdout: '', stderr: '' };
    return execStep('git', ['-C', projPath, 'add', '--', ...untracked], { timeout: 10000 });
  });
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
  mocks.pauseProjectMock.mockResolvedValue(true);
}
