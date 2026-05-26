import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishJobCancellation,
  getJobCancellationSignal,
  JobCancelledError,
  registerJobCancellation,
  requestJobCancellation,
  SAFE_PID_FLOOR,
  shouldSignalJobPid,
  shouldSignalJobPidForWallClockTimeout,
  throwIfJobCancelled,
} from '@/lib/jobs/cancellation';

describe('job cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the same signal for repeat registration and clears it on finish', () => {
    const jobId = `job-register-${Date.now()}`;

    const signal = registerJobCancellation(jobId);

    expect(registerJobCancellation(jobId)).toBe(signal);
    expect(getJobCancellationSignal(jobId)).toBe(signal);

    finishJobCancellation(jobId);

    expect(getJobCancellationSignal(jobId)).toBeNull();
  });

  it('aborts the signal and resolves true when cooperative cancellation finishes in time', async () => {
    const jobId = `job-cancel-${Date.now()}`;
    const signal = registerJobCancellation(jobId);

    const cancellation = requestJobCancellation(jobId, 50);

    expect(signal.aborted).toBe(true);

    finishJobCancellation(jobId);

    await expect(cancellation).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(getJobCancellationSignal(jobId)).toBeNull();
  });

  it('returns false when cooperative cancellation times out', async () => {
    const jobId = `job-timeout-${Date.now()}`;
    const signal = registerJobCancellation(jobId);
    const cancellation = requestJobCancellation(jobId, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(cancellation).resolves.toBe(false);
    expect(signal.aborted).toBe(true);
    expect(getJobCancellationSignal(jobId)).toBe(signal);

    finishJobCancellation(jobId);
  });

  it('returns false immediately when the job is not registered', async () => {
    await expect(requestJobCancellation(`missing-${Date.now()}`, 1)).resolves.toBe(false);
  });

  it('throws for aborted jobs or aborted signals', () => {
    expect(() => throwIfJobCancelled({ id: 'job-1', abortedAt: 123 }, null)).toThrow(JobCancelledError);

    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfJobCancelled({ id: 'job-2', abortedAt: null }, controller.signal)).toThrow(JobCancelledError);
    expect(() => throwIfJobCancelled({ id: 'job-3', abortedAt: null }, null)).not.toThrow();
  });

  it('signals only non-inline jobs with safe pids', () => {
    expect(shouldSignalJobPid({ pid: SAFE_PID_FLOOR, kind: 'review' })).toBe(false);
    expect(shouldSignalJobPid({ pid: SAFE_PID_FLOOR + 1, kind: 'push' })).toBe(false);
    expect(shouldSignalJobPid({ pid: SAFE_PID_FLOOR + 1, kind: 'commit' })).toBe(false);
    expect(shouldSignalJobPid({ pid: SAFE_PID_FLOOR + 1, kind: 'review' })).toBe(true);
  });

  it('allows wall-clock timeout signaling for inline jobs with safe detached pids', () => {
    expect(shouldSignalJobPidForWallClockTimeout({ pid: SAFE_PID_FLOOR + 1 })).toBe(true);
  });
});
