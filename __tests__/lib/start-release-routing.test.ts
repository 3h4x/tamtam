import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { defaultExec, getStartReleaseMocks, gitAhead, gitStatus, resetSharedMocks } from './start-release-fixtures';
import { tryClaimPipelineStartSlot, _resetPipelineStartSlots } from '@/lib/pipeline/pipeline-start-slot';

const mocks = getStartReleaseMocks();

describe('startRelease — release routing decisions', () => {
  let startRelease: typeof import('@/lib/pipeline/start-release').startRelease;
  const {
    execMock, listJobsMock, getVerdictMock, startProjectTestMock,
    detectTestCommandMock, startProjectReviewMock, startProjectPushMock,
    startProjectCommitMock, createJobMock, markDoneMock, getJobMock,
    isReviewedMock, detectMainBranchMock, getProjectTestConfigMock,
    acquireLockMock,
  } = mocks;

  beforeAll(async () => {
    ({ startRelease } = await import('@/lib/pipeline/start-release'));
  });

  beforeEach(() => {
    resetSharedMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('starts tests first when a test command is configured and there are changes', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // has tracked changes
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
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
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectTestMock).not.toHaveBeenCalled();
  });

  it('commits directly when only committed TamTam metadata paths are dirty and no test command is detected', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: false });
    execMock
      .mockImplementationOnce(() => gitStatus(' D .tamtam/agents/improve.md\n?? .tamtam/agents/improve-app.md\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('commit');
    expect(startProjectCommitMock).toHaveBeenCalledWith('proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectTestMock).not.toHaveBeenCalled();
  });

  it('starts review when only `.tamtam/cache/` paths are dirty and no test command is detected', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: false });
    execMock
      .mockImplementationOnce(() => gitStatus('?? .tamtam/cache/agent-memory/review.md\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 400, detail: 'No non-.tamtam changes to review' });

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('No non-.tamtam changes to review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('starts review when committed TamTam metadata is mixed with `.tamtam/cache/` dirt', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: false });
    execMock
      .mockImplementationOnce(() => gitStatus(' M .tamtam/config.yml\n?? .tamtam/cache/audits/improve.md\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 400, detail: 'No non-.tamtam changes to review' });

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('No non-.tamtam changes to review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('starts review when only `.tamtam/` paths are dirty but unpushed commits exist', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: false });
    execMock
      .mockImplementationOnce(() => gitStatus(' D .tamtam/agents/improve.md\n?? .tamtam/agents/improve-app.md\n'))
      .mockImplementationOnce(() => gitAhead('2'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('starts review when dirty paths mix `.tamtam/` and non-tamtam files with no test command', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: false });
    execMock
      .mockImplementationOnce(() => gitStatus(' M src/index.ts\n?? .tamtam/agents/improve.md\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('skips review and commits directly when review_disabled is set for the project', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: true });
    detectMainBranchMock.mockResolvedValue('master');
    execMock
      // Branch pre-flight: on default branch — check passes
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: 'master\n', stderr: '' }))
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('commit');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).toHaveBeenCalledTimes(1);
  });

  it('reviews when there are no uncommitted changes but unpushed commits exist', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))    // clean
      .mockImplementationOnce(() => gitAhead('2'))   // 2 unpushed
      .mockImplementation(defaultExec);
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
      .mockImplementationOnce(() => gitAhead('2'))   // 2 unpushed
      .mockImplementation(defaultExec);

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
      .mockImplementationOnce(() => gitAhead('1'))
      .mockImplementation(defaultExec);
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
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectTestMock.mockResolvedValue({ ok: false, status: 409, detail: 'Tests already running for proj' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already running');
    }
  });

  it('does NOT write a stop reason or finalize on a CONCURRENCY 409 first-step (release bows out healthy)', async () => {
    // A concurrency 409 means another driver already started this phase for the
    // release (it holds the start-slot / has an in-flight child). The release is
    // still healthy — the in-flight holder drives the chain — so the cleanup
    // path must bow out BEFORE persisting `releaseStopReason` or appending a
    // "failed" log line, and must not finalize the release row.
    _resetPipelineStartSlots();
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectTestMock.mockResolvedValue({ ok: false, status: 409, detail: 'Tests already running for proj' });
    const releaseRow: { id: string; project: string; kind: string; finishedAt: number | null; logPath: string | null; contextMeta: string | null } = {
      id: 'proj-release-rel-id', project: 'proj', kind: 'release', finishedAt: null, logPath: '/tmp/x.log', contextMeta: null,
    };
    getJobMock.mockImplementation((id: string) => (id === 'proj-release-rel-id' ? releaseRow : null));
    // Another driver holds the test start-slot for this release.
    tryClaimPipelineStartSlot('proj-release-rel-id', 'test');

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(releaseRow.contextMeta).toBeNull();
    expect(mocks.finalizeReleaseJobMock).not.toHaveBeenCalled();
    _resetPipelineStartSlots();
  });

  it('finalizes a PERMANENT-REFUSAL 409 first-step (no driver active) so the lock frees now', async () => {
    // A gate refusal (e.g. PR-branch execution gate) returns 409 but nothing is
    // running — no held slot, no in-flight child. The release must be finalized
    // here, not left `running` for the 120s childless-release reaper.
    _resetPipelineStartSlots();
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectTestMock.mockResolvedValue({ ok: false, status: 409, detail: 'Refusing to run tests on non-default branch feature: uncommitted changes.' });
    const releaseRow = { id: 'proj-release-rel-id', project: 'proj', kind: 'release', finishedAt: null as number | null, logPath: '/tmp/x.log', contextMeta: null as string | null };
    getJobMock.mockImplementation((id: string) => (id === 'proj-release-rel-id' ? releaseRow : null));

    const r = await startRelease('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(mocks.finalizeReleaseJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-release-rel-id' }),
      1,
    );
  });

  it('propagates failure from startProjectReview', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 500, detail: 'review spawn failed' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });

  it('propagates failure from startProjectReview for committed-diff review', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('1'))
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 502, detail: 'Review failed: quota blocked' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.detail).toContain('quota blocked');
    }
  });

  it('returns 409 without creating a job when lock cannot be acquired', async () => {
    acquireLockMock.mockResolvedValue({ acquired: false, blockingJobId: 'proj-release-running' });
    execMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status')) return gitStatus(' M foo.ts\n');
      if (cmd === 'git' && args.includes('rev-list')) return gitAhead('0');
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const r = await startRelease('proj');

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
    const latestReview = {
      id: 'prev-review', project: 'proj', kind: 'review',
      finishedAt: Date.now() / 1000 - 60, exitCode: 0,
    };
    listJobsMock.mockReturnValue([latestReview]);
    getVerdictMock.mockReturnValue('LGTM');
    isReviewedMock.mockResolvedValue(true);
    detectTestCommandMock.mockReturnValue('pnpm test');
    startProjectCommitMock.mockResolvedValue({ ok: true, commitSha: 'deadbee', message: 'committed' });
    startProjectPushMock.mockResolvedValue({ ok: true, commitSha: 'deadbee', message: 'pushed' });
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // hasChanges
      .mockImplementationOnce(() => gitAhead('0'))            // unpushed
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push'); // step label is still 'push' in the response
    expect(startProjectCommitMock).toHaveBeenCalledWith('proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectTestMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does NOT skip review when the working tree has changed since the LGTM (isReviewed=false)', async () => {
    const latestReview = {
      id: 'stale-review', project: 'proj', kind: 'review',
      finishedAt: Date.now() / 1000 - 60, exitCode: 0,
    };
    listJobsMock.mockReturnValue([latestReview]);
    getVerdictMock.mockReturnValue('LGTM');
    isReviewedMock.mockResolvedValue(false);
    detectTestCommandMock.mockReturnValue(null);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('creates a release meta-job and returns its id', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n'))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    startProjectTestMock.mockResolvedValue({ ok: true, jobId: 't1', pid: 1, logPath: '/tmp/t.log', testCmd: 'pnpm test' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.releaseJobId).toBe('proj-release-rel-id');
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
        null,
      );
    }
  });

  it('does not create a release meta-job when there is nothing to release', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('treats git status exit failure as no tracked changes', async () => {
    detectTestCommandMock.mockReturnValue(null);
    execMock
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 128, stdout: '', stderr: 'not a repo' }))
      .mockImplementationOnce(() => gitAhead('0'))
      .mockImplementation(defaultExec);
    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('runs tests before pushing when no uncommitted changes but test command is configured', async () => {
    // changes=false, unpushed=1 — with a test command, tests run first; hook chains to push.
    detectTestCommandMock.mockReturnValue('pnpm test');
    execMock
      .mockImplementationOnce(() => gitStatus(''))   // no uncommitted changes
      .mockImplementationOnce(() => gitAhead('1'))   // 1 unpushed commit
      .mockImplementation(defaultExec);
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
      .mockImplementationOnce(() => gitAhead('1'))   // 1 unpushed commit
      .mockImplementation(defaultExec);
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
    expect(startProjectTestMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('pushes directly when no uncommitted changes, no test command, and review is disabled', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: true });
    execMock
      .mockImplementationOnce(() => gitStatus(''))
      .mockImplementationOnce(() => gitAhead('1'))
      .mockImplementation(defaultExec);
    startProjectPushMock.mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });

    const r = await startRelease('proj');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('push');
    expect(startProjectPushMock).toHaveBeenCalledTimes(1);
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('allows releases from non-default non-issue branches', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ reviewDisabled: false });
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' })) // status --porcelain
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' }))        // rev-list --count
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
  });

  it('allows startRelease in Direct Branch mode when working copy is on a fix/issue-* branch', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false, reviewDisabled: false });
    detectMainBranchMock.mockResolvedValue('master');
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });
    execMock
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: 'fix/issue-45-my-bug\n', stderr: '' })) // branch --show-current (pre-flight)
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' }))           // status --porcelain (hasChanges)
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' }))                    // rev-list --count (hasUnpushedCommits)
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toBe('review');
  });

  it('skips branch pre-flight check in PR Workflow mode', async () => {
    detectTestCommandMock.mockReturnValue(null);
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true, reviewDisabled: false });
    detectMainBranchMock.mockResolvedValue('master');
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'r1' });
    // In PR Workflow mode, no branch check calls are made before hasChanges
    execMock
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' })) // hasChanges
      .mockImplementationOnce(() => Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' }))          // hasUnpushedCommits
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');
    expect(r.ok).toBe(true);
    // PR Workflow on any branch → review starts normally
    if (r.ok) expect(r.step).toBe('review');
  });

  it('returns 409 with blockingJobId when pipeline lock cannot be acquired', async () => {
    detectTestCommandMock.mockReturnValue('pnpm test');
    acquireLockMock.mockResolvedValue({ acquired: false, lock: {}, blockingJobId: 'blocking-job-42' });
    execMock
      .mockImplementationOnce(() => gitStatus(' M foo.ts\n')) // hasChanges
      .mockImplementationOnce(() => gitAhead('0'))            // unpushed
      .mockImplementation(defaultExec);

    const r = await startRelease('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already running');
      expect(r.blockingJobId).toBe('blocking-job-42');
    }
  });
});
