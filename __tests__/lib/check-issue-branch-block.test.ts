import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('checkIssueBranchBlock — agent concurrency guard', () => {
  let checkIssueBranchBlock: typeof import('@/lib/start-release').checkIssueBranchBlock;
  let execMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    getProjectTestConfigMock = vi.fn();

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: getProjectTestConfigMock,
    }));
    // Stub out all other start-release dependencies
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/proj'), clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/job-storage', () => ({ listJobs: vi.fn().mockReturnValue([]), probeJobStatus: vi.fn(), createJob: vi.fn(), updateJob: vi.fn(), markDone: vi.fn() }));
    vi.doMock('@/lib/pipeline-lock', () => ({ acquireLock: vi.fn(), getLock: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/start-test', () => ({ startProjectTest: vi.fn(), detectTestCommand: vi.fn() }));
    vi.doMock('@/lib/start-review', () => ({ startProjectReview: vi.fn() }));
    vi.doMock('@/lib/start-push', () => ({ startProjectPush: vi.fn() }));
    vi.doMock('@/lib/start-commit', () => ({ startProjectCommit: vi.fn(), detectMainBranch: vi.fn().mockResolvedValue('main') }));
    vi.doMock('@/lib/git-utils', () => ({ isReviewed: vi.fn() }));

    ({ checkIssueBranchBlock } = await import('@/lib/start-release'));
  });

  it('returns the branch name when on fix/issue-* in Direct Branch mode', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false });
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'fix/issue-45-my-bug\n', stderr: '' });

    const result = await checkIssueBranchBlock('proj', '/proj');
    expect(result).toBe('fix/issue-45-my-bug');
  });

  it('returns null when on default branch in Direct Branch mode', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false });
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'master\n', stderr: '' });

    const result = await checkIssueBranchBlock('proj', '/proj');
    expect(result).toBeNull();
  });

  it('returns null in PR Workflow mode even on a fix/issue-* branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });

    const result = await checkIssueBranchBlock('proj', '/proj');
    expect(result).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('returns null when project config is missing', async () => {
    getProjectTestConfigMock.mockReturnValue(null);

    const result = await checkIssueBranchBlock('proj', '/proj');
    expect(result).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });
});
