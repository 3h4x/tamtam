import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { defaultExec, getStartReleaseMocks, gitAhead, gitStatus, resetSharedMocks } from './start-release-fixtures';
import { tryClaimPipelineStartSlot, _resetPipelineStartSlots } from '@/lib/pipeline/pipeline-start-slot';

const mocks = getStartReleaseMocks();

describe('startRelease — release pipeline entry decision tree', () => {
  let startRelease: typeof import('@/lib/pipeline/start-release').startRelease;
  const {
    execMock, resolveProjectPathMock, listJobsMock, probeJobStatusMock,
    startProjectTestMock, detectTestCommandMock,
    startProjectReviewMock,
    createJobMock, updateJobMock, getJobMock,
    checkCliStartGateMock, setPendingReleaseMock,
    isIssueContextCompatibleWithCurrentBranchMock, findIssueContextMock,
    isProjectArchivedMock, isProjectPausedMock,
    getReleaseReadinessFailureMock,
  } = mocks;

  beforeAll(async () => {
    ({ startRelease } = await import('@/lib/pipeline/start-release'));
  });

  beforeEach(() => {
    resetSharedMocks();
  });

  afterEach(() => {
    // Drain in-memory state that some tests may have set on the shared module.
    vi.clearAllTimers();
  });

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
    // Dirty tree so the new "Nothing to release" early-exit doesn't fire
    // before the blocking-agent-slot check we're exercising here.
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
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
      .mockImplementation(defaultExec);
    // Force the meta-job creation to fail (no PM2 spawn anymore — the only
    // way the release-job creation can fail is if createJob throws).
    createJobMock.mockImplementationOnce(() => { throw new Error('db unavailable'); });

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
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
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
    expect(mocks.finalizeReleaseJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-release-rel-id', kind: 'release' }),
      1,
    );
  });

  it('finalizes immediately on a permanent-refusal 409 (gate) when no driver is active', async () => {
    _resetPipelineStartSlots();
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    // PR-branch gate refusal: 409, but nothing is actually running.
    startProjectTestMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Refusing to run tests on non-default branch feature: working tree has uncommitted or untracked changes that cannot be verified through GitHub commit authors.',
    });
    getJobMock.mockImplementation((id: string) =>
      id === 'proj-release-rel-id'
        ? { id, project: 'proj', kind: 'release', finishedAt: null, logPath: '/tmp/x.log', contextMeta: null }
        : null,
    );

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    // Finalized now (exit 1) so the lock frees immediately, not 120s later.
    expect(mocks.finalizeReleaseJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-release-rel-id', kind: 'release' }),
      1,
    );
  });

  it('bows out without finalizing on a concurrency 409 when another driver holds the start-slot', async () => {
    _resetPipelineStartSlots();
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectTestMock.mockResolvedValue({ ok: false, status: 409, detail: 'Tests already running for proj' });
    getJobMock.mockImplementation((id: string) =>
      id === 'proj-release-rel-id'
        ? { id, project: 'proj', kind: 'release', finishedAt: null, logPath: '/tmp/x.log', contextMeta: null }
        : null,
    );
    // Simulate another driver (e.g. boot-recovery resume) holding the test slot.
    tryClaimPipelineStartSlot('proj-release-rel-id', 'test');

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    // Healthy concurrency: leave the release running for the in-flight driver.
    expect(mocks.finalizeReleaseJobMock).not.toHaveBeenCalled();
    _resetPipelineStartSlots();
  });

  it('uses sourceJobId as the parent for a new release when it belongs to the project', async () => {
    getJobMock.mockReturnValue({ id: 'agent-123', project: 'proj' });
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj', { sourceJobId: 'agent-123' });

    expect(r.ok).toBe(true);
    expect(createJobMock).toHaveBeenCalledWith(
      'proj',
      'release',
      process.pid,
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
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
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

  it('marks the release as trusted-local-changes when triggered by an in-process agent run', async () => {
    getJobMock.mockReturnValue({ id: 'agent-ic', project: 'proj', kind: 'agent:issue-cruncher' });
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj', { sourceJobId: 'agent-ic' });

    expect(r.ok).toBe(true);
    const releaseUpdate = updateJobMock.mock.calls.find(([job]) => job.kind === 'release');
    expect(releaseUpdate).toBeDefined();
    expect(JSON.parse(releaseUpdate![0].contextMeta)).toMatchObject({ trustedLocalChanges: true });
  });

  it('marks the release as trusted-local-changes for an operator-initiated release (UI Release button)', async () => {
    getJobMock.mockReturnValue(null);
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj', { operatorInitiated: true });

    expect(r.ok).toBe(true);
    const releaseUpdate = updateJobMock.mock.calls.find(([job]) => job.kind === 'release');
    expect(releaseUpdate).toBeDefined();
    expect(JSON.parse(releaseUpdate![0].contextMeta)).toMatchObject({ trustedLocalChanges: true });
  });

  it('does NOT mark trusted-local-changes for a non-agent, non-issue source job', async () => {
    getJobMock.mockReturnValue({ id: 'commit-1', project: 'proj', kind: 'commit' });
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj', { sourceJobId: 'commit-1' });

    expect(r.ok).toBe(true);
    const releaseUpdate = updateJobMock.mock.calls.find(([job]) => job.kind === 'release');
    const meta = releaseUpdate?.[0].contextMeta ? JSON.parse(releaseUpdate[0].contextMeta) : {};
    expect(meta.trustedLocalChanges).toBeUndefined();
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
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
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
    listJobsMock.mockReturnValue([
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
    detectTestCommandMock.mockReturnValue(null);
    findIssueContextMock.mockResolvedValue({
      number: 42,
      repo: 'owner/repo',
      title: 'Fix login bug',
    });
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');

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

  it('fails fast with 503 when a required readiness check fails', async () => {
    getReleaseReadinessFailureMock.mockResolvedValue({
      name: 'provider:claude',
      ok: false,
      severity: 'error',
      message: 'Configured claude binary is not executable: /missing/claude',
    });

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.detail).toContain('provider:claude');
      expect(r.detail).toContain('/missing/claude');
    }
    expect(createJobMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('returns 409 when a pipeline job is already running for the project', async () => {
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'test', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('returns 409 when a commit pipeline job is already running (commit is a pipeline kind)', async () => {
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    listJobsMock.mockReturnValue([
      { id: 'j1', project: 'proj', kind: 'commit', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('blocks release startup when another project job is already running', async () => {
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
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

  it('returns 400 "Nothing to release" before queueing, even when a blocking job is running with queueIfBlocked', async () => {
    // Regression: prior order checked the blocking-job branch first, so a
    // queueIfBlocked caller (release-after-run hook) would always queue a
    // pending-release flag even when the working tree was empty. The flag
    // then stuck forever because every drain attempt bounced off the same
    // "agent already running" blocker. Fix: empty-tree check runs first.
    execMock
      .mockImplementationOnce(() => gitStatus(''))     // no changes
      .mockImplementationOnce(() => gitAhead('0'))    // no unpushed
      .mockImplementation(defaultExec);
    listJobsMock.mockReturnValue([
      { id: 'blocker', project: 'proj', kind: 'agent:foo', finishedAt: null },
    ]);
    probeJobStatusMock.mockResolvedValue('running');

    const r = await startRelease('proj', { queueIfBlocked: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('Nothing to release');
    }
  });

  it('returns 400 when there are no changes and no unpushed commits', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))     // no changes
      .mockImplementationOnce(() => gitAhead('0'))    // no unpushed
      .mockImplementation(defaultExec);
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('Nothing to release');
    }
  });
});
