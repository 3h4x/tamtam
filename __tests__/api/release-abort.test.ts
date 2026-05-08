import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';
import type { PipelineLock } from '@/lib/pipeline/pipeline-lock';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'release-1',
    project: 'proj1',
    kind: 'release',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    abortedAt: null,
    ...overrides,
  };
}

function makeLock(overrides: Partial<PipelineLock> = {}): PipelineLock {
  return {
    project: 'proj1',
    lockedByJobId: 'release-1',
    acquiredAt: 1000,
    ...overrides,
  };
}

describe('POST /api/projects/by-project/{projectName}/release/abort', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let getLockMock: ReturnType<typeof vi.fn>;
  let releaseLockMock: ReturnType<typeof vi.fn>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let requestJobCancellationMock: ReturnType<typeof vi.fn>;
  let processKillSpy: ReturnType<typeof vi.spyOn>;
  let finalizeAbortedReleaseMock: ReturnType<typeof vi.fn>;
  let notifyMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getLockMock = vi.fn().mockReturnValue(null);
    releaseLockMock = vi.fn();
    getJobMock = vi.fn().mockReturnValue(null);
    listJobsMock = vi.fn().mockReturnValue([]);
    updateJobMock = vi.fn();
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    requestJobCancellationMock = vi.fn().mockResolvedValue(true);
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    finalizeAbortedReleaseMock = vi.fn().mockResolvedValue(undefined);
    notifyMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: getLockMock,
      releaseLock: releaseLockMock,
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      listJobs: listJobsMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/cancellation', () => ({
      requestJobCancellation: requestJobCancellationMock,
      SAFE_PID_FLOOR: 100,
      shouldSignalJobPid: (job: { pid: number; kind: string }) => job.pid > 100 && job.kind !== 'push' && job.kind !== 'commit',
    }));
    vi.doMock('@/lib/jobs/lifecycle', () => ({
      finalizeAbortedRelease: finalizeAbortedReleaseMock,
    }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: notifyMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/release/abort/route');
    POST = mod.POST;
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    vi.resetModules();
  });

  function req(name = 'proj1') {
    return new NextRequest(`http://localhost/api/projects/by-project/${name}/release/abort`, {
      method: 'POST',
    });
  }

  it('returns no_pipeline when no lock exists', async () => {
    getLockMock.mockReturnValue(null);
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('no_pipeline');
  });

  it('returns no_pipeline and releases lock when release already finished', async () => {
    getLockMock.mockReturnValue(makeLock());
    getJobMock.mockReturnValue(makeJob({ finishedAt: 2000, exitCode: 0 }));

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('no_pipeline');
    expect(releaseLockMock).toHaveBeenCalledWith('proj1', 'release-1');
  });

  it('aborts a running release with no active step job', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob]);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('aborted');
    expect(data.release_id).toBe('release-1');
    expect(data.killed_job_id).toBeNull();

    // Release job should be marked aborted
    expect(releaseJob.abortedAt).not.toBeNull();
    expect(updateJobMock).toHaveBeenCalledWith(releaseJob);
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(releaseJob);

    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('kills the running step job and marks it aborted', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    const stepJob = makeJob({
      id: 'review-1',
      kind: 'review',
      pid: 1234,
      releaseId: 'release-1',
      finishedAt: null,
    });
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob, stepJob]);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.status).toBe('aborted');
    expect(data.killed_job_id).toBe('review-1');

    // Step job should be marked aborted
    expect(stepJob.abortedAt).not.toBeNull();
    expect(stepJob.finishedAt).not.toBeNull();
    expect(stepJob.exitCode).toBe(-3);
    expect(updateJobMock).toHaveBeenCalledWith(stepJob);
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(releaseJob);

    // pm2 stop/delete attempted on the step job
    expect(execMock).toHaveBeenCalledWith('pm2', ['stop', 'review-1', '--silent'], expect.any(Object));
    expect(execMock).toHaveBeenCalledWith('pm2', ['delete', 'review-1', '--silent'], expect.any(Object));

    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('does not kill an already-finished step job', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    const stepJob = makeJob({
      id: 'push-1',
      kind: 'push',
      pid: 999,
      releaseId: 'release-1',
      finishedAt: 1500, // already done
      exitCode: 0,
    });
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob, stepJob]);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.status).toBe('aborted');
    // Finished step is not the running one
    expect(data.killed_job_id).toBeNull();
    // No step-job pm2 calls — but the abort still stops the release's own
    // bash monitor, so allow exec calls targeting only `release-1`.
    const stepCalls = execMock.mock.calls.filter((c: unknown[]) =>
      Array.isArray(c[1]) && (c[1] as string[]).includes('push-1')
    );
    expect(stepCalls).toHaveLength(0);
  });

  it('does not signal an inline push step that reuses the server pid', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    const stepJob = makeJob({
      id: 'push-1',
      kind: 'push',
      pid: 999,
      releaseId: 'release-1',
      finishedAt: null,
    });
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob, stepJob]);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.status).toBe('aborted');
    expect(data.killed_job_id).toBe('push-1');
    expect(requestJobCancellationMock).toHaveBeenCalledWith('push-1', 20_000);
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(updateJobMock).toHaveBeenCalledWith(stepJob);
  });

  it('does not emit a duplicate abort notification when inline cancellation already finalized the release', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    const stepJob = makeJob({
      id: 'push-1',
      kind: 'push',
      pid: 999,
      releaseId: 'release-1',
      finishedAt: null,
    });
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob, stepJob]);
    requestJobCancellationMock.mockImplementation(async () => {
      releaseJob.finishedAt = 1234;
      releaseJob.exitCode = -3;
      stepJob.finishedAt = 1234;
      stepJob.exitCode = -3;
      return true;
    });

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(200);
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(releaseJob);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('returns 409 when inline cancellation does not finish cleanly', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    const stepJob = makeJob({
      id: 'commit-1',
      kind: 'commit',
      pid: 999,
      releaseId: 'release-1',
      finishedAt: null,
    });
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob, stepJob]);
    requestJobCancellationMock.mockResolvedValue(false);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe('abort_pending');
    expect(stepJob.finishedAt).toBeNull();
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalled();
  });

  it('does not kill the triggering parent job (releaseJob.parentJobId)', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob({ parentJobId: 'agent-1' });
    const parentJob = makeJob({
      id: 'agent-1',
      kind: 'agent:migration',
      pid: 555,
      releaseId: 'release-1',
      finishedAt: null,
    });
    const stepJob = makeJob({
      id: 'review-1',
      kind: 'review',
      pid: 1234,
      releaseId: 'release-1',
      finishedAt: null,
    });
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob, parentJob, stepJob]);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.status).toBe('aborted');
    // Should kill the review step, NOT the parent agent run
    expect(data.killed_job_id).toBe('review-1');
    expect(execMock).toHaveBeenCalledWith('pm2', ['stop', 'review-1', '--silent'], expect.any(Object));
    expect(execMock).not.toHaveBeenCalledWith('pm2', ['stop', 'agent-1', '--silent'], expect.any(Object));
    // Parent job must not be marked aborted
    expect(parentJob.abortedAt).toBeNull();
    expect(parentJob.finishedAt).toBeNull();
  });

  it('still releases lock even when pm2 stop throws', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    const stepJob = makeJob({ id: 'fix-1', kind: 'fix', pid: 42, releaseId: 'release-1', finishedAt: null });
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob, stepJob]);
    execMock.mockRejectedValue(new Error('pm2 not found'));

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('aborted');
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(releaseJob);
  });

  it('aborts an orphan release (no lock, but unfinished release row exists)', async () => {
    getLockMock.mockReturnValue(null);
    getJobMock.mockReturnValue(null);
    const orphanRelease = makeJob({ id: 'orphan-1' });
    listJobsMock.mockReturnValue([orphanRelease]);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('aborted');
    expect(data.release_id).toBe('orphan-1');
    expect(updateJobMock).toHaveBeenCalledWith(orphanRelease);
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(orphanRelease);
    // Lock not held, so releaseLock must not be called
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('returns no_pipeline when no lock and no orphan release exists', async () => {
    getLockMock.mockReturnValue(null);
    getJobMock.mockReturnValue(null);
    listJobsMock.mockReturnValue([
      makeJob({ id: 'other-1', kind: 'review', project: 'proj1', finishedAt: null }),
      makeJob({ id: 'done-rel', kind: 'release', project: 'proj1', finishedAt: 9999 }),
    ]);

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('no_pipeline');
    expect(data.detail).toBe('no active pipeline lock');
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('ignores orphan releases for other projects', async () => {
    getLockMock.mockReturnValue(null);
    getJobMock.mockReturnValue(null);
    // Release for a different project — must not be picked up
    listJobsMock.mockReturnValue([
      makeJob({ id: 'other-proj-rel', kind: 'release', project: 'proj2', finishedAt: null }),
    ]);

    const res = await POST(req('proj1'), { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.status).toBe('no_pipeline');
  });

  it('stops the release bash monitor process even when no step job is running', async () => {
    getLockMock.mockReturnValue(makeLock());
    const releaseJob = makeJob();
    getJobMock.mockReturnValue(releaseJob);
    listJobsMock.mockReturnValue([releaseJob]);

    await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(releaseJob);
  });
});
