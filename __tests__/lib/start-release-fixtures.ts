import { vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted shared mock factories. Top-level vi.mock() lets every test reuse the
// same compiled module graph for start-release — much faster than calling
// vi.resetModules() + vi.doMock() per test.
// ─────────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  return {
    isProjectArchivedMock: vi.fn(),
    isProjectPausedMock: vi.fn(),
    execMock: vi.fn(),
    resolveProjectPathMock: vi.fn(),
    listJobsMock: vi.fn(),
    probeJobStatusMock: vi.fn(),
    getVerdictMock: vi.fn(),
    startProjectTestMock: vi.fn(),
    detectTestCommandMock: vi.fn(),
    startProjectReviewMock: vi.fn(),
    startProjectPushMock: vi.fn(),
    startProjectCommitMock: vi.fn(),
    createJobMock: vi.fn(),
    updateJobMock: vi.fn(),
    markDoneMock: vi.fn(),
    getJobMock: vi.fn(),
    checkCliStartGateMock: vi.fn(),
    setPendingReleaseMock: vi.fn(),
    isReviewedMock: vi.fn(),
    isIssueContextCompatibleWithCurrentBranchMock: vi.fn(),
    findIssueContextMock: vi.fn(),
    detectMainBranchMock: vi.fn(),
    acquireLockMock: vi.fn(),
    releaseLockMock: vi.fn(),
    reassignLockMock: vi.fn(),
    isLockOwnedByActiveReleaseMock: vi.fn(),
    getLockMock: vi.fn(),
    findActiveReleaseJobMock: vi.fn(),
    getProjectTestConfigMock: vi.fn(),
    finalizeReleaseJobMock: vi.fn(),
    finalizeAbortedReleaseMock: vi.fn(),
    getReleaseReadinessFailureMock: vi.fn(),
    checkDailySpendCapMock: vi.fn(),
    notifyMock: vi.fn(),
  };
});

export function getStartReleaseMocks() {
  return mocks;
}

vi.mock('@/lib/shared/enabled-projects', () => ({
  isProjectArchived: (...args: unknown[]) => mocks.isProjectArchivedMock(...args),
  isProjectPaused: (...args: unknown[]) => mocks.isProjectPausedMock(...args),
}));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));
vi.mock('@/lib/shared/project-data', () => ({ resolveProjectPath: mocks.resolveProjectPathMock }));
vi.mock('@/lib/jobs/job-storage', () => ({
  listJobs: mocks.listJobsMock,
  probeJobStatus: mocks.probeJobStatusMock,
  createJob: mocks.createJobMock,
  updateJob: mocks.updateJobMock,
  getJob: mocks.getJobMock,
  findActiveReleaseJob: mocks.findActiveReleaseJobMock,
  getVerdict: mocks.getVerdictMock,
  markDone: mocks.markDoneMock,
  runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
  PIPELINE_STEP_KINDS: new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod']),
}));
vi.mock('@/lib/jobs/storage', () => ({
  listJobs: mocks.listJobsMock,
  getJob: mocks.getJobMock,
  findActiveReleaseJob: mocks.findActiveReleaseJobMock,
}));
vi.mock('@/lib/git/git-utils', () => ({
  isReviewed: mocks.isReviewedMock,
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
  getProjectTestConfig: (...args: unknown[]) => mocks.getProjectTestConfigMock(...args),
}));
vi.mock('@/lib/pipeline/start-test', () => ({
  startProjectTest: mocks.startProjectTestMock,
  detectTestCommand: mocks.detectTestCommandMock,
}));
vi.mock('@/lib/pipeline/start-review', () => ({
  startProjectReview: mocks.startProjectReviewMock,
}));
vi.mock('@/lib/pipeline/start-push', () => ({
  startProjectPush: mocks.startProjectPushMock,
}));
vi.mock('@/lib/pipeline/start-commit', () => ({
  startProjectCommit: mocks.startProjectCommitMock,
  detectMainBranch: mocks.detectMainBranchMock,
  findIssueContext: mocks.findIssueContextMock,
  isIssueContextCompatibleWithCurrentBranch: mocks.isIssueContextCompatibleWithCurrentBranchMock,
}));
vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  acquireLock: mocks.acquireLockMock,
  releaseLock: mocks.releaseLockMock,
  reassignLock: mocks.reassignLockMock,
  isLockOwnedByActiveRelease: mocks.isLockOwnedByActiveReleaseMock,
  getLock: mocks.getLockMock,
}));
vi.mock('@/lib/usage/resolve-provider', () => ({
  checkCliStartGate: mocks.checkCliStartGateMock,
}));
vi.mock('@/lib/shared/readiness', () => ({
  getReleaseReadinessFailure: mocks.getReleaseReadinessFailureMock,
}));
vi.mock('@/lib/pipeline/pending-release', () => ({
  setPendingRelease: mocks.setPendingReleaseMock,
}));
vi.mock('@/lib/jobs/lifecycle', () => ({
  finalizeReleaseJob: mocks.finalizeReleaseJobMock,
  finalizeAbortedRelease: mocks.finalizeAbortedReleaseMock,
}));
vi.mock('@/lib/pipeline/spend-guard', () => ({
  checkDailySpendCap: mocks.checkDailySpendCapMock,
}));
vi.mock('@/lib/shared/notifications', () => ({
  notify: mocks.notifyMock,
}));
// Stub out the file-config loader so anything reaching wrapIfUntrusted /
// getBranchContext does not shell out to `git` (via execFileSync) — each
// real git invocation against a non-existent project path costs ~10ms.
vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: () => null,
}));

function defaultCreateJob(project: string, kind: string) {
  return {
    id: `${project}-${kind}-rel-id`, project, kind, pid: 0, logPath: '',
    prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    durationMs: null, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    contextMeta: null, userPrompt: null,
  };
}

export function defaultExec(_cmd: string, _args: string[]) {
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
}

export function resetSharedMocks() {
  for (const m of Object.values(mocks)) {
    m.mockReset();
  }
  // Default exec mock: every call succeeds; git calls must be set per-test via
  // mockImplementationOnce (they take priority over this default).
  mocks.execMock.mockImplementation(defaultExec);
  mocks.isProjectArchivedMock.mockReturnValue(false);
  mocks.isProjectPausedMock.mockReturnValue(false);
  mocks.resolveProjectPathMock.mockReturnValue('/path/to/proj');
  mocks.listJobsMock.mockReturnValue([]);
  mocks.getVerdictMock.mockReturnValue(null);
  mocks.startProjectPushMock.mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });
  mocks.startProjectCommitMock.mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' });
  mocks.createJobMock.mockImplementation(defaultCreateJob);
  mocks.getJobMock.mockReturnValue(null);
  mocks.checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'claude' });
  mocks.getReleaseReadinessFailureMock.mockResolvedValue(null);
  mocks.isReviewedMock.mockResolvedValue(false);
  mocks.isIssueContextCompatibleWithCurrentBranchMock.mockResolvedValue(true);
  mocks.findIssueContextMock.mockResolvedValue(null);
  mocks.detectMainBranchMock.mockResolvedValue('main');
  mocks.acquireLockMock.mockResolvedValue({
    acquired: true,
    lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 },
  });
  mocks.isLockOwnedByActiveReleaseMock.mockReturnValue(false);
  mocks.getLockMock.mockReturnValue(null);
  mocks.findActiveReleaseJobMock.mockReturnValue(null);
  mocks.getProjectTestConfigMock.mockReturnValue(null);
  mocks.checkDailySpendCapMock.mockResolvedValue({ ok: true });
  mocks.notifyMock.mockResolvedValue(undefined);
  mocks.finalizeReleaseJobMock.mockResolvedValue(undefined);
}

export function gitStatus(porcelain: string) {
  return Promise.resolve({ exitCode: 0, stdout: porcelain, stderr: '' });
}

export function gitAhead(count: string) {
  return Promise.resolve({ exitCode: 0, stdout: count, stderr: '' });
}
