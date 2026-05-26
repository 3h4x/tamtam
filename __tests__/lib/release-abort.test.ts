import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  let execMock: ReturnType<typeof vi.fn>;
  let requestJobCancellationMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    getLockMock = vi.fn().mockReturnValue({ project: 'proj1', lockedByJobId: 'release-1', acquiredAt: 1000 });
    releaseLockMock = vi.fn();
    getJobMock = vi.fn();
    listJobsMock = vi.fn();
    updateJobMock = vi.fn();
    finalizeAbortedReleaseMock = vi.fn().mockResolvedValue(undefined);
    notifyMock = vi.fn().mockResolvedValue(undefined);
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    requestJobCancellationMock = vi.fn().mockResolvedValue(true);

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
      exec: execMock,
    }));
    vi.doMock('@/lib/jobs/cancellation', async () => {
      const actual = await vi.importActual<typeof import('@/lib/jobs/cancellation')>('@/lib/jobs/cancellation');
      return {
        ...actual,
        requestJobCancellation: requestJobCancellationMock,
      };
    });
    vi.doMock('@/lib/jobs/redacted-log-writer', () => ({
      appendRedactedFileSync: vi.fn(),
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: notifyMock,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('wall_clock_timeout does not finalize a wedged inline push step without a safe pid', async () => {
    const release = makeJob();
    const runningPush = makeJob({
      id: 'push-1',
      kind: 'push',
      pid: process.pid,
      releaseId: 'release-1',
      startedAt: 1500,
    });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release, runningPush]);
    requestJobCancellationMock.mockResolvedValue(false);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', { reason: 'wall_clock_timeout' });

    expect(result).toEqual({
      status: 'abort_pending',
      detail: 'Timed out waiting for push to stop cleanly',
      release_id: 'release-1',
      killed_job_id: null,
      httpStatus: 409,
    });
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
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

  it('falls back to the newest active release when no lock is available', async () => {
    const olderRelease = makeJob({ id: 'release-older', startedAt: 1000 });
    const newerRelease = makeJob({ id: 'release-newer', startedAt: 2000 });
    const finishedRelease = makeJob({ id: 'release-finished', startedAt: 3000, finishedAt: 3100 });
    const otherProjectRelease = makeJob({ id: 'release-other', project: 'proj2', startedAt: 4000 });
    getLockMock.mockReturnValue(null);
    listJobsMock.mockReturnValue([
      olderRelease,
      newerRelease,
      finishedRelease,
      otherProjectRelease,
    ]);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', { reason: 'user' });

    expect(result).toMatchObject({
      status: 'aborted',
      release_id: 'release-newer',
      killed_job_id: null,
      httpStatus: 200,
    });
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(newerRelease);
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalledWith(olderRelease);
  });

  it('returns abort_pending when a commit step does not stop after cancellation', async () => {
    const release = makeJob();
    const runningCommit = makeJob({
      id: 'commit-1',
      kind: 'commit',
      pid: 99999,
      releaseId: 'release-1',
      startedAt: 1500,
    });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release, runningCommit]);
    requestJobCancellationMock.mockResolvedValue(false);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', { reason: 'user' });

    expect(result).toEqual({
      status: 'abort_pending',
      detail: 'Timed out waiting for commit to stop cleanly',
      release_id: 'release-1',
      killed_job_id: null,
      httpStatus: 409,
    });
    expect(requestJobCancellationMock).toHaveBeenCalledWith('commit-1', 20_000);
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(updateJobMock).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'commit-1' }));
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('wall_clock_timeout does not finalize a wedged inline commit step without a safe pid', async () => {
    const release = makeJob();
    const runningCommit = makeJob({
      id: 'commit-1',
      kind: 'commit',
      pid: process.pid,
      releaseId: 'release-1',
      startedAt: 1500,
    });
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release, runningCommit]);
    requestJobCancellationMock.mockResolvedValue(false);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', { reason: 'wall_clock_timeout' });

    expect(result).toEqual({
      status: 'abort_pending',
      detail: 'Timed out waiting for commit to stop cleanly',
      release_id: 'release-1',
      killed_job_id: null,
      httpStatus: 409,
    });
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(finalizeAbortedReleaseMock).not.toHaveBeenCalled();
  });

  it('signals a non-inline running step and force-kills it on the timer', async () => {
    const release = makeJob();
    const runningReview = makeJob({
      id: 'review-1',
      kind: 'review',
      pid: 99999,
      releaseId: 'release-1',
      startedAt: 1500,
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release, runningReview]);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const resultPromise = abortActiveRelease('proj1', { reason: 'user' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({
      status: 'aborted',
      release_id: 'release-1',
      killed_job_id: 'review-1',
      httpStatus: 200,
    });
    expect(killSpy).toHaveBeenNthCalledWith(1, 99999, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, 99999, 'SIGKILL');
    expect(updateJobMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'review-1',
      abortedAt: expect.any(Number),
      finishedAt: expect.any(Number),
      exitCode: -3,
    }));
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(release);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      event: 'release_aborted',
      reason: 'user',
    }));
  });

  it('refuses to signal suspicious low pids and still finalizes the abort', async () => {
    const release = makeJob();
    const runningReview = makeJob({
      id: 'review-1',
      kind: 'review',
      pid: 42,
      releaseId: 'release-1',
      startedAt: 1500,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    getJobMock.mockReturnValue(release);
    listJobsMock.mockReturnValue([release, runningReview]);

    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const result = await abortActiveRelease('proj1', { reason: 'user' });

    expect(result).toMatchObject({
      status: 'aborted',
      release_id: 'release-1',
      killed_job_id: 'review-1',
      httpStatus: 200,
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[release-abort] refusing to signal suspicious pid=42 for review-1 (review)',
    );
    expect(updateJobMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'review-1',
      abortedAt: expect.any(Number),
      finishedAt: expect.any(Number),
      exitCode: -3,
    }));
    expect(finalizeAbortedReleaseMock).toHaveBeenCalledWith(release);
  });
});
