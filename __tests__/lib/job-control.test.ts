import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('job-control', () => {
  let isJobsPaused: typeof import('@/lib/job-control').isJobsPaused;
  let jobsPausedResult: typeof import('@/lib/job-control').jobsPausedResult;
  let syncJobsPauseState: typeof import('@/lib/job-control').syncJobsPauseState;
  let pauseInternalSchedulerMock: ReturnType<typeof vi.fn>;
  let resumeInternalSchedulerMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    pauseInternalSchedulerMock = vi.fn();
    resumeInternalSchedulerMock = vi.fn();
    vi.doMock('@/lib/internal-scheduler', () => ({
      pauseInternalScheduler: pauseInternalSchedulerMock,
      resumeInternalScheduler: resumeInternalSchedulerMock,
    }));
    ({ isJobsPaused, jobsPausedResult, syncJobsPauseState } = await import('@/lib/job-control'));
  });

  afterEach(() => vi.resetModules());

  describe('isJobsPaused', () => {
    it('returns false by default', () => {
      expect(isJobsPaused()).toBe(false);
    });

    it('returns true after syncJobsPauseState(true)', () => {
      syncJobsPauseState(true);
      expect(isJobsPaused()).toBe(true);
    });

    it('returns false after syncJobsPauseState(false)', () => {
      syncJobsPauseState(true);
      syncJobsPauseState(false);
      expect(isJobsPaused()).toBe(false);
    });
  });

  describe('jobsPausedResult', () => {
    it('returns null when jobs are not paused', () => {
      expect(jobsPausedResult()).toBeNull();
    });

    it('returns error object when jobs are paused', () => {
      syncJobsPauseState(true);
      const result = jobsPausedResult();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
      expect(result!.status).toBe(409);
      expect(result!.detail).toContain('Jobs are paused');
    });

    it('includes default action in detail when no action given', () => {
      syncJobsPauseState(true);
      const result = jobsPausedResult();
      expect(result!.detail).toContain('start new jobs');
    });

    it('includes custom action in detail', () => {
      syncJobsPauseState(true);
      const result = jobsPausedResult('start a fix job');
      expect(result!.detail).toContain('start a fix job');
    });
  });

  describe('syncJobsPauseState', () => {
    it('calls pauseInternalScheduler when paused=true', () => {
      syncJobsPauseState(true);
      expect(pauseInternalSchedulerMock).toHaveBeenCalledOnce();
      expect(resumeInternalSchedulerMock).not.toHaveBeenCalled();
    });

    it('calls resumeInternalScheduler when paused=false', () => {
      syncJobsPauseState(false);
      expect(resumeInternalSchedulerMock).toHaveBeenCalledOnce();
      expect(pauseInternalSchedulerMock).not.toHaveBeenCalled();
    });

    it('toggles state correctly across multiple calls', () => {
      syncJobsPauseState(true);
      expect(isJobsPaused()).toBe(true);
      syncJobsPauseState(false);
      expect(isJobsPaused()).toBe(false);
      syncJobsPauseState(true);
      expect(isJobsPaused()).toBe(true);
    });
  });
});
