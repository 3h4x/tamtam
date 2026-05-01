import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('job-control', () => {
  let isJobsPaused: typeof import('@/lib/shared/job-control').isJobsPaused;
  let jobsPausedResult: typeof import('@/lib/shared/job-control').jobsPausedResult;
  let syncJobsPauseState: typeof import('@/lib/shared/job-control').syncJobsPauseState;
  let budgetBlockedResult: typeof import('@/lib/shared/job-control').budgetBlockedResult;
  let runGates: typeof import('@/lib/shared/job-control').runGates;
  let pauseInternalSchedulerMock: ReturnType<typeof vi.fn>;
  let resumeInternalSchedulerMock: ReturnType<typeof vi.fn>;
  let listPendingMock: ReturnType<typeof vi.fn>;
  let drainMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let peekQuotaCacheMock: ReturnType<typeof vi.fn>;
  let prefetchQuotaMock: ReturnType<typeof vi.fn>;
  let notifyMock: ReturnType<typeof vi.fn>;

  function makeSettings(overrides: Record<string, unknown> = {}) {
    return {
      budget_block_runs_enabled: true,
      budget_block_at_pct: 95,
      budget_warn_at_pct: 80,
      ...overrides,
    };
  }

  function makeSnapshot(fiveHourPct: number, sevenDayPct: number, resetsAt: string | null = null) {
    return {
      fiveHour: { utilization: fiveHourPct, resetsAt, msUntilReset: null },
      sevenDay: { utilization: sevenDayPct, resetsAt, msUntilReset: null },
      fetchedAt: Date.now(),
      stale: false,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    pauseInternalSchedulerMock = vi.fn();
    resumeInternalSchedulerMock = vi.fn();
    listPendingMock = vi.fn().mockReturnValue([]);
    drainMock = vi.fn().mockResolvedValue(undefined);
    getSettingsMock = vi.fn().mockReturnValue(makeSettings());
    peekQuotaCacheMock = vi.fn().mockReturnValue(null);
    prefetchQuotaMock = vi.fn();
    notifyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/scheduling/internal-scheduler', () => ({
      pauseInternalScheduler: pauseInternalSchedulerMock,
      resumeInternalScheduler: resumeInternalSchedulerMock,
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      listPendingReleaseProjects: listPendingMock,
      drainPendingRelease: drainMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: getSettingsMock,
    }));
    vi.doMock('@/lib/usage/claude-quota', () => ({
      peekQuotaCache: peekQuotaCacheMock,
      prefetchQuota: prefetchQuotaMock,
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: notifyMock,
    }));
    ({ isJobsPaused, jobsPausedResult, syncJobsPauseState, budgetBlockedResult, runGates } =
      await import('@/lib/shared/job-control'));
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

    it('drains pending releases for each queued project when resuming after a pause', async () => {
      listPendingMock.mockReturnValue(['proj-a', 'proj-b']);
      syncJobsPauseState(true);
      syncJobsPauseState(false);
      // drain is async fire-and-forget — wait a microtask cycle
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(listPendingMock).toHaveBeenCalled();
      expect(drainMock).toHaveBeenCalledWith('proj-a');
      expect(drainMock).toHaveBeenCalledWith('proj-b');
    });

    it('does not drain pending releases when resuming without a prior pause', async () => {
      listPendingMock.mockReturnValue(['proj-a']);
      // syncJobsPauseState(false) without ever having called true first
      syncJobsPauseState(false);
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(drainMock).not.toHaveBeenCalled();
    });

    it('does not drain pending releases when pausing', async () => {
      listPendingMock.mockReturnValue(['proj-a']);
      syncJobsPauseState(true);
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(drainMock).not.toHaveBeenCalled();
    });
  });

  describe('budgetBlockedResult', () => {
    it('returns null when budget_block_runs_enabled is false', () => {
      getSettingsMock.mockReturnValue(makeSettings({ budget_block_runs_enabled: false }));
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(99, 99));
      expect(budgetBlockedResult()).toBeNull();
    });

    it('returns null when cache is empty (fail-open)', () => {
      peekQuotaCacheMock.mockReturnValue(null);
      expect(budgetBlockedResult()).toBeNull();
    });

    it('triggers background prefetch on every call', () => {
      peekQuotaCacheMock.mockReturnValue(null);
      budgetBlockedResult();
      expect(prefetchQuotaMock).toHaveBeenCalled();
    });

    it('returns null when both windows are below the limit', () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(50, 40));
      expect(budgetBlockedResult()).toBeNull();
    });

    it('returns 429 when 5h utilization meets the limit', () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(95, 40));
      const result = budgetBlockedResult('start a run');
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
      expect(result!.status).toBe(429);
      expect(result!.window).toBe('5h');
      expect(result!.utilization).toBe(95);
      expect(result!.detail).toContain('5h');
    });

    it('does not block when only 7d utilization exceeds the limit', () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(50, 96));
      expect(budgetBlockedResult()).toBeNull();
    });

    it('blocks on 5h even when 7d is also over', () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(97, 99));
      const result = budgetBlockedResult();
      expect(result!.window).toBe('5h');
    });

    it('returns null when utilization is strictly below the limit', () => {
      getSettingsMock.mockReturnValue(makeSettings({ budget_block_at_pct: 95 }));
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(94, 94));
      expect(budgetBlockedResult()).toBeNull();
    });

    it('fires a notification on first block', async () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(96, 40, '2099-01-01T00:00:00Z'));
      budgetBlockedResult('run tests');
      // notify is fire-and-forget; wait a microtask
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'budget_blocked' })
      );
    });

    it('debounces repeated notifications for the same window+resetsAt within 60 s', async () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(96, 40, '2099-01-01T00:00:00Z'));
      budgetBlockedResult();
      budgetBlockedResult();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('runGates', () => {
    it('returns null when both gates are clear', () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(50, 40));
      expect(runGates()).toBeNull();
    });

    it('returns pause result when jobs are paused (checked first)', () => {
      syncJobsPauseState(true);
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(99, 99));
      const result = runGates();
      expect(result).not.toBeNull();
      expect(result!.detail).toContain('paused');
    });

    it('returns budget blocked result when not paused but over budget', () => {
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(96, 40));
      const result = runGates('start a release');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);
      expect(result!.detail).toContain('quota');
    });

    it('returns pause result before budget check when both gates would block', () => {
      syncJobsPauseState(true);
      peekQuotaCacheMock.mockReturnValue(makeSnapshot(99, 99));
      const result = runGates();
      expect(result!.detail).toContain('paused');
    });
  });
});
