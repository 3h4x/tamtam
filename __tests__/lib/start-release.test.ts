import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/types';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';

const isProjectArchivedMock = vi.fn().mockReturnValue(false);
const isProjectPausedMock = vi.fn().mockReturnValue(false);
vi.mock('@/lib/shared/enabled-projects', () => ({
  isProjectArchived: (...args: unknown[]) => isProjectArchivedMock(...args),
  isProjectPaused: (...args: unknown[]) => isProjectPausedMock(...args),
}));

describe('startRelease — release pipeline entry decision tree', () => {
  let startRelease: typeof import('@/lib/pipeline/start-release').startRelease;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let startProjectTestMock: ReturnType<typeof vi.fn>;
  let detectTestCommandMock: ReturnType<typeof vi.fn>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let setPendingReleaseMock: ReturnType<typeof vi.fn>;
  let isReviewedMock: ReturnType<typeof vi.fn>;
  let isIssueContextCompatibleWithCurrentBranchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn();
    getVerdictMock = vi.fn().mockReturnValue(null);
    startProjectTestMock = vi.fn();
    detectTestCommandMock = vi.fn();
    startProjectReviewMock = vi.fn();
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-rel-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
    updateJobMock = vi.fn();
    markDoneMock = vi.fn();
    getJobMock = vi.fn().mockReturnValue(null);
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });
    setPendingReleaseMock = vi.fn();
    isReviewedMock = vi.fn().mockResolvedValue(false);
    isIssueContextCompatibleWithCurrentBranchMock = vi.fn().mockResolvedValue(true);

    // Default exec mock: PM2 calls succeed; git calls must be set per-test via
    // mockImplementationOnce (they take priority over this default).
    execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'pm2' && args[0] === 'start') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (cmd === 'pm2' && args[0] === 'jlist') {
        // Return a valid process so the pid-retry loop breaks on first attempt (avoids 5×200ms wait)
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
      createJob: createJobMock, updateJob: updateJobMock, getJob: getJobMock,
      findActiveReleaseJob: vi.fn().mockReturnValue(null),
      getVerdict: getVerdictMock,
      markDone: markDoneMock,
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      listJobs: listJobsMock,
      getJob: getJobMock,
      findActiveReleaseJob: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      isReviewed: isReviewedMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }),
      detectMainBranch: vi.fn().mockResolvedValue('main'),
      findIssueContext: vi.fn().mockResolvedValue(null),
      isIssueContextCompatibleWithCurrentBranch: isIssueContextCompatibleWithCurrentBranchMock,
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: checkCliStartGateMock }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({ setPendingRelease: setPendingReleaseMock }));
    vi.doMock('@/lib/jobs/lifecycle', () => ({ finalizeReleaseJob: vi.fn().mockResolvedValue(undefined) }));

    ({ startRelease } = await import('@/lib/pipeline/start-release'));
  });

  afterEach(() => { vi.resetModules(); });

  function gitStatus(porcelain: string) {
    return Promise.resolve({ exitCode: 0, stdout: porcelain, stderr: '' });
  }
  function gitAhead(count: string) {
    return Promise.resolve({ exitCode: 0, stdout: count, stderr: '' });
  }

  it('returns 404 when project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const r = await startRelease('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('returns 409 when the project is archived', async () => {
    isProjectArchivedMock.mockReturnValueOnce(true);
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toBe('project archived');
    }
    expect(createJobMock).not.toHaveBeenCalled();
    expect(startProjectTestMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the project is paused', async () => {
    isProjectPausedMock.mockReturnValueOnce(true);
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toBe('project paused');
    }
    expect(createJobMock).not.toHaveBeenCalled();
    expect(startProjectTestMock).not.toHaveBeenCalled();
  });

  it('blocks release startup while an agent prerequisite holds the project start slot', async () => {
    const { tryClaimAgentStartSlot, releaseAgentStartSlot } = await import('@/lib/agents/pending-agent-run');
    expect(tryClaimAgentStartSlot('proj', 'Prereq Agent')).toEqual({ ok: true });
    try {
      const r = await startRelease('proj');

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(409);
        expect(r.blockingJobId).toBe('proj-agent-starting');
        expect(r.detail).toContain("Job 'agent:Prereq Agent' is already running");
      }
      expect(createJobMock).not.toHaveBeenCalled();
      expect(startProjectTestMock).not.toHaveBeenCalled();
    } finally {
      releaseAgentStartSlot('proj');
    }
  });

  it('marks release-job startup failures as retryable before any step starts', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') {
          return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'pm2 start failed' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toBe('Failed to create release job');
      expect(r.retryable).toBe(true);
    }
  });

  it('finalizes the release row and releases the lock when the first step fails to start', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectTestMock.mockResolvedValue({ ok: false, status: 500, detail: 'test launch failed' });
    // After createReleaseJob updates the freshly-minted release, the cleanup
    // path looks it up to call finalizeReleaseJob.
    getJobMock.mockImplementation((id: string) =>
      id === 'proj-release-rel-id'
        ? { id, project: 'proj', kind: 'release', finishedAt: null, logPath: '/tmp/x.log' }
        : null,
    );

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toBe('test launch failed');
    }
    const { finalizeReleaseJob } = await import('@/lib/jobs/lifecycle');
    expect(finalizeReleaseJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-release-rel-id', kind: 'release' }),
      1,
    );
  });

  it('uses sourceJobId as the parent for a new release when it belongs to the project', async () => {
    getJobMock.mockReturnValue({ id: 'agent-123', project: 'proj' });
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj', { sourceJobId: 'agent-123' });

    expect(r.ok).toBe(true);
    expect(createJobMock).toHaveBeenCalledWith(
      'proj',
      'release',
      0,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'agent-123',
    );
  });

  it('stamps issue context onto the release root when started from an issue-linked source job', async () => {
    getJobMock.mockReturnValue({
      id: 'run-issue-42',
      project: 'proj',
      kind: 'run',
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Fix login bug',
    });
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj', { sourceJobId: 'run-issue-42' });

    expect(r.ok).toBe(true);
    expect(updateJobMock.mock.calls.some(([job]) =>
      job.kind === 'release' &&
      job.ghIssueNumber === 42 &&
      job.ghIssueRepo === 'owner/repo' &&
      job.ghIssueTitle === 'Fix login bug'
    )).toBe(true);
  });

  it('does not stamp stale source-job issue context when the current branch is an unrelated feature branch', async () => {
    getJobMock.mockReturnValue({
      id: 'run-issue-42',
      project: 'proj',
      kind: 'run',
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Fix login bug',
    });
    isIssueContextCompatibleWithCurrentBranchMock.mockResolvedValue(false);
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj', { sourceJobId: 'run-issue-42' });

    expect(r.ok).toBe(true);
    expect(updateJobMock.mock.calls.some(([job]) =>
      job.kind === 'release' &&
      job.ghIssueNumber === 42 &&
      job.ghIssueRepo === 'owner/repo'
    )).toBe(false);
    expect(isIssueContextCompatibleWithCurrentBranchMock).toHaveBeenCalledWith({
      number: 42,
      repo: 'owner/repo',
      title: 'Fix login bug',
    }, '/path/to/proj');
  });

  it('stamps issue context onto the release root for a plain release without sourceJobId', async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    listJobsMock = vi.fn().mockReturnValue([
      {
        id: 'issue-42-run',
        project: 'proj',
        kind: 'run',
        startedAt: Date.now() / 1000 - 120,
        ghIssueNumber: 42,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Fix login bug',
      },
      {
        id: 'issue-99-run',
        project: 'proj',
        kind: 'run',
        startedAt: Date.now() / 1000 - 60,
        ghIssueNumber: 99,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Wrong issue',
      },
    ]);
    probeJobStatusMock = vi.fn();
    getVerdictMock = vi.fn().mockReturnValue(null);
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-rel-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
    updateJobMock = vi.fn();
    markDoneMock = vi.fn();
    getJobMock = vi.fn().mockReturnValue(null);
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: 'fix/issue-42-fix-login-bug\n', stderr: '' }))
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' }))
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: '{"state":"OPEN"}', stderr: '' }))
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: getJobMock,
      findActiveReleaseJob: vi.fn().mockReturnValue(null),
      getVerdict: getVerdictMock,
      markDone: markDoneMock,
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      listJobs: listJobsMock,
      getJob: getJobMock,
      findActiveReleaseJob: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      isReviewed: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }),
      detectMainBranch: vi.fn().mockResolvedValue('main'),
      findIssueContext: vi.fn().mockResolvedValue({
        number: 42,
        repo: 'owner/repo',
        title: 'Fix login bug',
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }) }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');

    expect(r.ok).toBe(true);
    expect(updateJobMock.mock.calls.some(([job]) =>
      job.kind === 'release' &&
      job.ghIssueNumber === 42 &&
      job.ghIssueRepo === 'owner/repo' &&
      job.ghIssueTitle === 'Fix login bug'
    )).toBe(true);
  });

  it('queues a pending release when the budget gate blocks startup', async () => {
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'Claude quota exceeded',
    });

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    expect(setPendingReleaseMock).toHaveBeenCalledWith('proj');
    expect(createJobMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('does not queue a pending release for a manual global pause', async () => {
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally',
    });

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(setPendingReleaseMock).not.toHaveBeenCalled();
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 when a pipeline job is already running for the project', async () => {
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'test', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('returns 409 when a fix-push pipeline job is already running (fix-push is a pipeline kind)', async () => {
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'fix-push', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('blocks release startup when another project job is already running', async () => {
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'run', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.blockingJobId).toBe('j1');
      expect(r.detail).toContain("Job 'run' is already running");
    }
  });

  it('returns 400 when there are no changes and no unpushed commits', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))     // no changes
      .mockImplementationOnce(() => gitAhead('0'));    // no unpushed
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('Nothing to release');
    }
  });

  it('starts tests first when a test command is configured and there are changes', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // has tracked changes
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectTestMock.mockResolvedValue({ ok: true, jobId: 't1', pid: 1, logPath: '/tmp/t.log', testCmd: 'pnpm test' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.step).toBe('test');
      expect(r.jobId).toBe('t1');
      expect(r.message).toContain('pnpm test');
    }
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts review when there are changes and no test command is detected', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus('?? new.ts\n')) // untracked changes only — should still release
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectTestMock).not.toHaveBeenCalled();
  });

  it('skips review and commits directly when review_disabled is set for the project', async () => {
    vi.resetModules();
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    const startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' });
    execMock = vi.fn()
      // Branch pre-flight: on default branch — check passes
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: 'master\n', stderr: '' }))
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        if (cmd === 'pm2') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
      createJob: createJobMock, updateJob: updateJobMock,
      getJob: getJobMock,
      getVerdict: vi.fn().mockReturnValue(null), markDone: vi.fn(),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      // prWorkflowEnabled not set → treated as false (Direct Branch) → branch pre-flight runs
      getProjectTestConfig: () => ({ reviewDisabled: true }),
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: startProjectCommitMock,
      detectMainBranch: vi.fn().mockResolvedValue('master'),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }) }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('commit');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).toHaveBeenCalledTimes(1);
  });

  it('reviews when there are no uncommitted changes but unpushed commits exist', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))    // clean
      .mockImplementationOnce(() => gitAhead('2'));   // 2 unpushed
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('pushes directly when there are no uncommitted changes, unpushed commits, and a fresh LGTM', async () => {
    detectTestCommandMock.mockReturnValue(null);
    listJobsMock.mockReturnValue([
      {
        id: 'review-1',
        project: 'proj',
        kind: 'review',
        finishedAt: 100,
        exitCode: 0,
      },
    ]);
    getVerdictMock.mockReturnValue('LGTM');
    isReviewedMock.mockResolvedValue(true);
    execMock
      .mockImplementationOnce(() => gitStatus(''))    // clean
      .mockImplementationOnce(() => gitAhead('2'));   // 2 unpushed

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push');
    expect(startProjectPushMock).toHaveBeenCalledWith('proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('re-runs review when there are no uncommitted changes, unpushed commits, and the LGTM is stale', async () => {
    detectTestCommandMock.mockReturnValue(null);
    listJobsMock.mockReturnValue([
      {
        id: 'review-1',
        project: 'proj',
        kind: 'review',
        finishedAt: 100,
        exitCode: 0,
      },
    ]);
    getVerdictMock.mockReturnValue('LGTM');
    isReviewedMock.mockResolvedValue(false);
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('1'));
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r-stale' });

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('propagates failure from startProjectTest', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectTestMock.mockResolvedValue({ ok: false, status: 409, detail: 'Tests already running for proj' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already running');
    }
  });

  it('propagates failure from startProjectReview', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 500, detail: 'review spawn failed' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });

  it('propagates failure from startProjectReview for committed-diff review', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('1'));
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 502, detail: 'Review failed: quota blocked' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.detail).toContain('quota blocked');
    }
  });

  it('returns 409 without creating a job when lock cannot be acquired', async () => {
    vi.resetModules();
    execMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status')) return gitStatus(' M foo.ts\n');
      if (cmd === 'git' && args.includes('rev-list')) return gitAhead('0');
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: false, blockingJobId: 'proj-release-running' }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
    }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.blockingJobId).toBe('proj-release-running');
    }
    // No job must be created — the race is resolved before touching the DB
    expect(createJobMock).not.toHaveBeenCalled();
    expect(markDoneMock).not.toHaveBeenCalled();
  });

  it('skips test+review and commits directly when a fresh LGTM review exists with uncommitted changes', async () => {
    vi.resetModules();
    const latestReview = {
      id: 'prev-review', project: 'proj', kind: 'review',
      finishedAt: Date.now() / 1000 - 60, exitCode: 0,
    };
    const listJobsWithReview = vi.fn().mockReturnValue([latestReview]);
    const getVerdictLgtm = vi.fn().mockReturnValue('LGTM');
    const isReviewedTrue = vi.fn().mockResolvedValue(true);
    const startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'deadbee', message: 'committed' });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'deadbee', message: 'pushed' });
    detectTestCommandMock = vi.fn().mockReturnValue('pnpm test');
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // hasChanges
      .mockImplementationOnce(() => gitAhead('0'))            // unpushed
      // PM2 / jlist calls from createReleaseJob:
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsWithReview,
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: getJobMock,
      getVerdict: getVerdictLgtm,
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: isReviewedTrue }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }) }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push'); // step label is still 'push' in the response
    expect(startProjectCommitMock).toHaveBeenCalledWith('proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectTestMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does NOT skip review when the working tree has changed since the LGTM (isReviewed=false)', async () => {
    vi.resetModules();
    const latestReview = {
      id: 'stale-review', project: 'proj', kind: 'review',
      finishedAt: Date.now() / 1000 - 60, exitCode: 0,
    };
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([latestReview]),
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: getJobMock,
      getVerdict: vi.fn().mockReturnValue('LGTM'),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }) }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('creates a release meta-job and returns its id', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'));
    startProjectTestMock.mockResolvedValue({ ok: true, jobId: 't1', pid: 1, logPath: '/tmp/t.log', testCmd: 'pnpm test' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.releaseJobId).toBe('proj-release-rel-id');
      expect(createJobMock).toHaveBeenCalledWith(
        'proj',
        'release',
        0,
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        null,
      );
    }
  });

  it('does not create a release meta-job when there is nothing to release', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('0'));

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('treats git status exit failure as no tracked changes', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 128, stdout: '', stderr: 'not a repo' }))
      .mockImplementationOnce(() => gitAhead('0'));
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('runs tests before pushing when no uncommitted changes but test command is configured', async () => {
    // changes=false, unpushed=1 — with a test command, tests run first; hook chains to push.
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(''))   // no uncommitted changes
      .mockImplementationOnce(() => gitAhead('1'));   // 1 unpushed commit
    startProjectTestMock.mockResolvedValue({ ok: true, jobId: 'test-1', testCmd: 'pnpm test' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('test');
    expect(startProjectTestMock).toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('reviews unpushed commits when no uncommitted changes and no test command', async () => {
    // changes=false, unpushed=1, no test command — review committed diff before push.
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))   // no uncommitted changes
      .mockImplementationOnce(() => gitAhead('1'));   // 1 unpushed commit
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectTestMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('pushes directly when no uncommitted changes, no test command, and review is disabled', async () => {
    vi.resetModules();
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('1'))
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
      createJob: createJobMock, updateJob: updateJobMock, getJob: getJobMock,
      getVerdict: vi.fn().mockReturnValue(null),
      markDone: markDoneMock,
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => ({ reviewDisabled: true }),
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }) }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: checkCliStartGateMock }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({ setPendingRelease: setPendingReleaseMock }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push');
    expect(startProjectPushMock).toHaveBeenCalledTimes(1);
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('allows releases from non-default non-issue branches', async () => {
    vi.resetModules();
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' })) // status --porcelain
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' }))        // rev-list --count
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2') return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
      createJob: createJobMock, updateJob: updateJobMock,
      getJob: getJobMock,
      getVerdict: vi.fn().mockReturnValue(null), markDone: vi.fn(),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => ({ reviewDisabled: false }),
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: {} }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
    }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
  });

  it('allows startRelease in Direct Branch mode when working copy is on a fix/issue-* branch', async () => {
    vi.resetModules();
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: 'fix/issue-45-my-bug\n', stderr: '' })) // branch --show-current (pre-flight)
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' }))           // status --porcelain (hasChanges)
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' }))                    // rev-list --count (hasUnpushedCommits)
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
      createJob: createJobMock, updateJob: updateJobMock,
      getJob: getJobMock,
      getVerdict: vi.fn().mockReturnValue(null), markDone: vi.fn(),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => ({ prWorkflowEnabled: false, reviewDisabled: false }),
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }),
      detectMainBranch: vi.fn().mockResolvedValue('master'),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: {} }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
    }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
  });

  it('skips branch pre-flight check in PR Workflow mode', async () => {
    vi.resetModules();
    detectTestCommandMock = vi.fn().mockReturnValue(null);
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'r1' });
    // In PR Workflow mode, no branch check calls are made before hasChanges
    execMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' })) // hasChanges
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' }))          // hasUnpushedCommits
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'start') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
      createJob: createJobMock, updateJob: updateJobMock,
      getJob: getJobMock,
      getVerdict: vi.fn().mockReturnValue(null), markDone: vi.fn(),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => ({ prWorkflowEnabled: true, reviewDisabled: false }),
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }),
      detectMainBranch: vi.fn().mockResolvedValue('master'),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: {} }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
    }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');
    expect(r.ok).toBe(true);
    // PR Workflow on any branch → review starts normally
    if (r.ok) expect(r.step).toBe('review');
  });

  it('returns 409 with blockingJobId when pipeline lock cannot be acquired', async () => {
    vi.resetModules();
    detectTestCommandMock = vi.fn().mockReturnValue('pnpm test');
    execMock = vi.fn()
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // hasChanges
      .mockImplementationOnce(() => gitAhead('0'))            // unpushed
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'pm2' && args[0] === 'jlist') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
        if (cmd === 'pm2') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: getJobMock,
      getVerdict: vi.fn().mockReturnValue(null),
      markDone: vi.fn(),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ isReviewed: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock, detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' }) }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: false, lock: {}, blockingJobId: 'blocking-job-42' }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));

    const { startRelease: fn } = await import('@/lib/pipeline/start-release');
    const r = await fn('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already running');
      expect(r.blockingJobId).toBe('blocking-job-42');
    }
  });
});

describe('startRelease — legacy review stamp compatibility', () => {
  let startRelease: typeof import('@/lib/pipeline/start-release').startRelease;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;

  let tempDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    vi.resetModules();

    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-release-legacy-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'tamtam-release-cache-'));

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return {
        ...actual,
        homedir: () => cacheDir,
      };
    });

    resolveProjectPathMock = vi.fn().mockReturnValue(join(tempDir, 'proj'));
    listJobsMock = vi.fn().mockReturnValue([
      { id: 'review-legacy', project: 'proj', kind: 'review', finishedAt: 100, exitCode: 0 },
    ]);
    getVerdictMock = vi.fn().mockReturnValue('LGTM');
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-rel-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
    updateJobMock = vi.fn();
    markDoneMock = vi.fn();
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });

    execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'status') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-list') {
        return Promise.resolve({ exitCode: 0, stdout: '1\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === 'HEAD') {
        return Promise.resolve({ exitCode: 0, stdout: 'head-a\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '@{u}') {
        return Promise.resolve({ exitCode: 0, stdout: 'upstream-a\n', stderr: '' });
      }
      if (cmd === 'pm2' && args[0] === 'start') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (cmd === 'pm2' && args[0] === 'jlist') {
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    mkdirSync(join(cacheDir, '.cache', 'tamtam', 'schedule-reviews'), { recursive: true });
    writeFileSync(
      join(cacheDir, '.cache', 'tamtam', 'schedule-reviews', 'proj.hash'),
      'da39a3ee5e6b4b0d3255bfef95601890afd80709\n',
    );

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/git/git-utils', async () => {
      const actual = await vi.importActual<typeof import('@/lib/git/git-utils')>('@/lib/git/git-utils');
      return actual;
    });
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: vi.fn(),
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: vi.fn().mockReturnValue(null),
      getVerdict: getVerdictMock,
      markDone: markDoneMock,
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: vi.fn(), detectTestCommand: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: vi.fn() }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }) }));

    ({ startRelease } = await import('@/lib/pipeline/start-release'));
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('pushes directly when a legacy plain-hash review stamp still matches', async () => {
    const result = await startRelease('proj');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.step).toBe('push');
    expect(startProjectPushMock).toHaveBeenCalledWith('proj');
    expect(readFileSync(join(cacheDir, '.cache', 'tamtam', 'schedule-reviews', 'proj.hash'), 'utf-8')).toContain('"version":1');
  });
});

describe('startRelease weekly quota gating', () => {
  let startRelease: typeof import('@/lib/pipeline/start-release').startRelease;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/usage/resolve-provider');

    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'review-1' });
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-rel-id`,
      project,
      kind,
      pid: 0,
      logPath: '',
      prompt: null,
      startedAt: 0,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      contextMeta: null,
      userPrompt: null,
    }));
    updateJobMock = vi.fn();

    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 97, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);

    execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'status') {
        return Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-list') {
        return Promise.resolve({ exitCode: 0, stdout: '0', stderr: '' });
      }
      if (cmd === 'pm2' && args[0] === 'start') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (cmd === 'pm2' && args[0] === 'jlist') {
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ name: 'proj-release-rel-id', pid: 1234 }]), stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(),
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: vi.fn().mockReturnValue(null),
      findActiveReleaseJob: vi.fn().mockReturnValue(null),
      getVerdict: vi.fn().mockReturnValue(null),
      markDone: vi.fn(),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      getJob: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      isReviewed: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({
      startProjectTest: vi.fn(),
      detectTestCommand: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn(),
      detectMainBranch: vi.fn().mockResolvedValue('main'),
      findIssueContext: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({
        acquired: true,
        lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 },
      }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn(() => ({
        cli_enabled_providers: ['claude', 'codex'],
        claude_provider: 'claude',
        budget_block_at_pct: 95,
        budget_block_runs_enabled: true,
      })),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      jobsPausedResult: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/quota', () => ({
      getQuotaSnapshots: vi.fn().mockResolvedValue(snapshots),
    }));

    ({ startRelease } = await import('@/lib/pipeline/start-release'));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not 429 a root release when only weekly quota is hot', async () => {
    const result = await startRelease('proj');

    expect(result.ok).toBe(true);
    if (result.ok && 'step' in result) {
      expect(result.step).toBe('review');
    }
    expect(startProjectReviewMock).toHaveBeenCalledOnce();
    expect(createJobMock).toHaveBeenCalledOnce();
    expect(updateJobMock).toHaveBeenCalled();
  });
});
