import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/job-storage';
import type { PipelineLock } from '@/lib/pipeline-lock';

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

  beforeEach(async () => {
    vi.resetModules();

    getLockMock = vi.fn().mockReturnValue(null);
    releaseLockMock = vi.fn();
    getJobMock = vi.fn().mockReturnValue(null);
    listJobsMock = vi.fn().mockReturnValue([]);
    updateJobMock = vi.fn();
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/pipeline-lock', () => ({
      getLock: getLockMock,
      releaseLock: releaseLockMock,
    }));
    vi.doMock('@/lib/job-storage', () => ({
      getJob: getJobMock,
      listJobs: listJobsMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/release/abort/route');
    POST = mod.POST;
  });

  afterEach(() => {
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
    expect(releaseJob.finishedAt).not.toBeNull();
    expect(releaseJob.exitCode).toBe(-3);
    expect(updateJobMock).toHaveBeenCalledWith(releaseJob);

    // Lock released
    expect(releaseLockMock).toHaveBeenCalledWith('proj1', 'release-1');
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

    // pm2 stop/delete attempted on the step job
    expect(execMock).toHaveBeenCalledWith('pm2', ['stop', 'review-1', '--silent'], expect.any(Object));
    expect(execMock).toHaveBeenCalledWith('pm2', ['delete', 'review-1', '--silent'], expect.any(Object));

    // Lock released
    expect(releaseLockMock).toHaveBeenCalledWith('proj1', 'release-1');
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
    expect(execMock).not.toHaveBeenCalled();
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
    expect(releaseLockMock).toHaveBeenCalledWith('proj1', 'release-1');
  });
});
