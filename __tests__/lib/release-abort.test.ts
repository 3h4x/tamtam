import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

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

describe('abortActiveRelease', () => {
  let getLockMock: ReturnType<typeof vi.fn>;
  let releaseLockMock: ReturnType<typeof vi.fn>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let finalizeAbortedReleaseMock: ReturnType<typeof vi.fn>;
  let notifyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    getLockMock = vi.fn().mockReturnValue({ project: 'proj1', lockedByJobId: 'release-1', acquiredAt: 1000 });
    releaseLockMock = vi.fn();
    getJobMock = vi.fn();
    listJobsMock = vi.fn();
    updateJobMock = vi.fn();
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
    vi.doMock('@/lib/jobs/lifecycle', () => ({
      finalizeAbortedRelease: finalizeAbortedReleaseMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/jobs/cancellation', () => ({
      requestJobCancellation: vi.fn().mockResolvedValue(true),
      SAFE_PID_FLOOR: 100,
      shouldSignalJobPid: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/redacted-log-writer', () => ({
      appendRedactedFileSync: vi.fn(),
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: notifyMock,
    }));
  });

  it('emits release_aborted with the wall-clock timeout reason', async () => {
    const release = makeJob();
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release]);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', {
      reason: 'wall_clock_timeout',
      targetReleaseId: 'release-1',
    });

    expect(result).toMatchObject({
      status: 'aborted',
      release_id: 'release-1',
      killed_job_id: null,
      httpStatus: 200,
    });
    expect(updateJobMock).toHaveBeenCalledWith(expect.objectContaining({ abortedAt: expect.any(Number) }));
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(release);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      event: 'release_aborted',
      project: 'proj1',
      job_id: 'release-1',
      reason: 'wall_clock_timeout',
    }));
  });

  it('aborts the targeted expired release instead of the currently locked one', async () => {
    const activeRelease = makeJob({ id: 'release-active', startedAt: 2000 });
    const expiredRelease = makeJob({ id: 'release-expired', startedAt: 1000 });
    getLockMock.mockReturnValue({ project: 'proj1', lockedByJobId: 'release-active', acquiredAt: 2000 });
    getJobMock.mockImplementation((jobId: string) => {
      if (jobId === 'release-active') return activeRelease;
      if (jobId === 'release-expired') return expiredRelease;
      return null;
    });
    listJobsMock.mockReturnValue([activeRelease, expiredRelease]);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', {
      reason: 'wall_clock_timeout',
      targetReleaseId: 'release-expired',
    });

    expect(result).toMatchObject({
      status: 'aborted',
      release_id: 'release-expired',
      killed_job_id: null,
      httpStatus: 200,
    });
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(expiredRelease);
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalledWith(activeRelease);
    expect(updateJobMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'release-expired' }));
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('returns no_pipeline and clears a stale lock when the release already finished', async () => {
    getJobMock.mockReturnValue(makeJob({ finishedAt: 2000, exitCode: 0 }));
    listJobsMock.mockReturnValue([]);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', { reason: 'user' });

    expect(result).toEqual({
      status: 'no_pipeline',
      detail: 'release already finished',
      httpStatus: 200,
    });
    expect(releaseLockMock).toHaveBeenCalledWith('proj1', 'release-1');
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalled();
  });

  it('returns no_pipeline for a missing timeout target without clearing the active lock', async () => {
    const activeRelease = makeJob({ id: 'release-active', startedAt: 2000 });
    getLockMock.mockReturnValue({ project: 'proj1', lockedByJobId: 'release-active', acquiredAt: 2000 });
    getJobMock.mockImplementation((jobId: string) => jobId === 'release-active' ? activeRelease : null);
    listJobsMock.mockReturnValue([activeRelease]);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', {
      reason: 'wall_clock_timeout',
      targetReleaseId: 'release-expired',
    });

    expect(result).toEqual({
      status: 'no_pipeline',
      detail: 'target release is not active',
      httpStatus: 200,
    });
    expect(releaseLockMock).not.toHaveBeenCalled();
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalled();
  });
});
