import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'release-1',
    project: 'proj1',
    kind: 'release',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    abortedAt: null,
    ...overrides,
  };
}

describe('POST /api/projects/by-project/{projectName}/release/{releaseId}/resume', () => {
  let POST: (
    req: NextRequest,
    ctx: { params: Promise<{ projectName: string; releaseId: string }> }
  ) => Promise<Response>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let runCompletionHooksMock: ReturnType<typeof vi.fn>;
  let acquireLockMock: ReturnType<typeof vi.fn>;
  let releaseLockMock: ReturnType<typeof vi.fn>;
  let updatedJobs: Array<Pick<JobData, 'id' | 'finishedAt' | 'exitCode'>>;

  beforeEach(async () => {
    vi.resetModules();

    getJobMock = vi.fn().mockReturnValue(null);
    listJobsMock = vi.fn().mockReturnValue([]);
    updatedJobs = [];
    updateJobMock = vi.fn().mockImplementation((job: JobData) => {
      updatedJobs.push({
        id: job.id,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
      });
    });
    runCompletionHooksMock = vi.fn().mockResolvedValue(undefined);
    acquireLockMock = vi.fn().mockResolvedValue({
      acquired: true,
      lock: { project: 'proj1', lockedByJobId: 'release-1', acquiredAt: 1000 },
    });
    releaseLockMock = vi.fn();

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      listJobs: listJobsMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/jobs/lifecycle', () => ({
      runCompletionHooks: runCompletionHooksMock,
      PIPELINE_STEP_KINDS: new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod']),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: acquireLockMock,
      releaseLock: releaseLockMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/release/[releaseId]/resume/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  function req(projectName = 'proj1', releaseId = 'release-1') {
    return new NextRequest(`http://localhost/api/projects/by-project/${projectName}/release/${releaseId}/resume`, {
      method: 'POST',
    });
  }

  function params(projectName = 'proj1', releaseId = 'release-1') {
    return { params: Promise.resolve({ projectName, releaseId }) };
  }

  it('returns 404 when the release is missing', async () => {
    const res = await POST(req(), params());
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ detail: 'release not found' });
  });

  it('returns 409 when the release is still active', async () => {
    getJobMock.mockReturnValue(makeJob({ finishedAt: null, exitCode: null }));
    const res = await POST(req(), params());
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('still active');
  });

  it('returns 409 when the release has no pipeline steps to resume from', async () => {
    getJobMock.mockReturnValue(makeJob());
    listJobsMock.mockReturnValue([]);
    const res = await POST(req(), params());
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('no pipeline steps');
  });

  it('returns 409 when the last step is terminal or failed', async () => {
    getJobMock.mockReturnValue(makeJob());
    listJobsMock.mockReturnValue([
      makeJob({ id: 'push-1', kind: 'push', releaseId: 'release-1', startedAt: 1010, finishedAt: 1020, exitCode: 0 }),
    ]);
    const res = await POST(req(), params());
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('not a stuck non-terminal step');
  });

  it('returns 409 and does not reopen the release when another release owns the project lock', async () => {
    const release = makeJob();
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      makeJob({ id: 'review-1', kind: 'review', releaseId: 'release-1', startedAt: 1010, finishedAt: 1020, exitCode: 0 }),
    ]);
    acquireLockMock.mockResolvedValue({
      acquired: false,
      blockingJobId: 'release-2',
      lock: { project: 'proj1', lockedByJobId: 'release-2', acquiredAt: 1005 },
    });

    const res = await POST(req(), params());

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('pipeline is already running');
    expect(data.blocking_job_id).toBe('release-2');
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
    expect(release.finishedAt).toBe(2000);
    expect(release.exitCode).toBe(0);
  });

  it('returns 409 and does not reopen the release when another pipeline step is already running', async () => {
    const release = makeJob();
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([
      makeJob({ id: 'review-1', kind: 'review', releaseId: 'release-1', startedAt: 1010, finishedAt: 1020, exitCode: 0 }),
      makeJob({ id: 'test-live', kind: 'test', releaseId: 'other-release', startedAt: 1030, finishedAt: null, exitCode: null }),
    ]);

    const res = await POST(req(), params());

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('another pipeline step is still running');
    expect(data.blocking_job_id).toBe('test-live');
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(runCompletionHooksMock).not.toHaveBeenCalled();
    expect(release.finishedAt).toBe(2000);
    expect(release.exitCode).toBe(0);
  });

  it('reopens the release and re-fires completion hooks on the last non-terminal success step', async () => {
    const release = makeJob();
    const lastStep = makeJob({
      id: 'commit-1',
      kind: 'commit',
      releaseId: 'release-1',
      startedAt: 1010,
      finishedAt: 1020,
      exitCode: 0,
    });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([lastStep]);

    const res = await POST(req(), params());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'resumed',
      release: 'release-1',
      project: 'proj1',
      resumedFrom: { kind: 'commit', id: 'commit-1' },
    });
    expect(updatedJobs).toEqual([{
      id: 'release-1',
      finishedAt: null,
      exitCode: null,
    }]);
    expect(runCompletionHooksMock).toHaveBeenCalledWith(lastStep);
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('rolls back the reopened release and releases the lock when hook launch fails', async () => {
    const release = makeJob();
    const lastStep = makeJob({
      id: 'test-1',
      kind: 'test',
      releaseId: 'release-1',
      startedAt: 1010,
      finishedAt: 1020,
      exitCode: 0,
    });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([lastStep]);
    runCompletionHooksMock.mockRejectedValue(new Error('boom'));

    const res = await POST(req(), params());

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('completion hook threw: boom');
    expect(updatedJobs[0]).toEqual({
      id: 'release-1',
      finishedAt: null,
      exitCode: null,
    });
    expect(updatedJobs[1]).toEqual({
      id: 'release-1',
      finishedAt: 2000,
      exitCode: 0,
    });
    expect(release.finishedAt).toBe(2000);
    expect(release.exitCode).toBe(0);
    expect(releaseLockMock).toHaveBeenCalledWith('proj1', 'release-1');
  });
});
