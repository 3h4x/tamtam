import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeNextFire,
  startInternalScheduler,
  pauseInternalScheduler,
  resumeInternalScheduler,
  stopInternalScheduler,
  upsertAgentSchedule,
  removeAgentSchedule,
  dumpInternalScheduler,
  setSchedulerBaseUrl,
} from '@/lib/internal-scheduler';

describe('internal-scheduler', () => {
  beforeEach(() => {
    stopInternalScheduler();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopInternalScheduler();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('computeNextFire', () => {
    it('returns a future timestamp for hourly schedule', () => {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      const next = computeNextFire('1h', 'agent-x', now);
      expect(next).toBeGreaterThan(now);
      expect(next - now).toBeLessThanOrEqual(3600_000);
    });

    it('returns a future timestamp for sub-hour schedule', () => {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      const next = computeNextFire('15m', 'agent-y', now);
      expect(next).toBe(now + 15 * 60_000);
    });

    it('uses agent-stable phase offset (different agents in same period spread out)', () => {
      const now = Date.UTC(2026, 0, 1, 0, 0, 0);
      const a = computeNextFire('4h', 'agent-A', now);
      const b = computeNextFire('4h', 'agent-B', now);
      // Should be deterministic for the same agent
      expect(computeNextFire('4h', 'agent-A', now)).toBe(a);
      // Different agents almost certainly land on different times
      expect(a).not.toBe(b);
    });

    it('rolls to next-day slot when today\'s window has passed', () => {
      const now = Date.UTC(2026, 0, 1, 23, 59, 0);
      const next = computeNextFire('24h', 'agent-z', now);
      expect(next).toBeGreaterThan(now);
      expect(next - now).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
    });
  });

  describe('upsert / remove', () => {
    it('arms a timer that fires at the computed time', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      setSchedulerBaseUrl('http://test');

      upsertAgentSchedule({
        id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'do', enabled: true,
      });

      const dump = dumpInternalScheduler();
      expect(dump.entries).toHaveLength(1);
      expect(dump.entries[0].agentId).toBe('a1');
      expect(dump.entries[0].fireCount).toBe(0);

      // Advance past the scheduled time. fire() is async (awaits the
      // issue-branch lock probe before fetching), so drain microtasks.
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      for (let _i = 0; _i < 20; _i++) await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/api/agents/a1/run',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'X-Tamtam-Trigger': 'schedule' }),
        })
      );
    });

    it('replaces an existing entry on upsert (no duplicate timers)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      setSchedulerBaseUrl('http://test');

      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'v1', enabled: true });
      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'v2', enabled: true });

      expect(dumpInternalScheduler().entries).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000 + 100);
      for (let _i = 0; _i < 20; _i++) await Promise.resolve();
      // Only one fire — old timer was cleared
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1].body).toContain('v2');
    });

    it('remove cancels the scheduled timer', () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      setSchedulerBaseUrl('http://test');

      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'do', enabled: true });
      removeAgentSchedule('a1');

      expect(dumpInternalScheduler().entries).toHaveLength(0);

      vi.advanceTimersByTime(60_000 + 100);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('upsert with enabled=false is a no-op (no entry, no timer)', () => {
      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'x', enabled: false });
      expect(dumpInternalScheduler().entries).toHaveLength(0);
    });

    it('upsert with null/empty schedule is a no-op', () => {
      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '' as string, prompt: 'x', enabled: true });
      expect(dumpInternalScheduler().entries).toHaveLength(0);
    });
  });

  describe('startInternalScheduler', () => {
    it('arms a schedule for every input agent and is idempotent on re-call', () => {
      startInternalScheduler([
        { id: 'a1', project: 'p1', name: 'n1', schedule: '1h', prompt: 'x', enabled: true },
        { id: 'a2', project: 'p2', name: 'n2', schedule: '4h', prompt: 'y', enabled: true },
      ]);
      expect(dumpInternalScheduler().entries).toHaveLength(2);

      // Re-call clears and re-arms
      startInternalScheduler([
        { id: 'a3', project: 'p3', name: 'n3', schedule: '2h', prompt: 'z', enabled: true },
      ]);
      const after = dumpInternalScheduler();
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0].agentId).toBe('a3');
    });

    it('records errorCount on failed fire and re-arms next', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', fetchMock);
      setSchedulerBaseUrl('http://test');

      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'x', enabled: true });

      await vi.advanceTimersByTimeAsync(60_000 + 100);
      // Drain microtasks for the dynamic imports (pipeline-lock, job-storage)
      // and the fetch promise + the post-fire armNext call.
      for (let i = 0; i < 8; i++) await Promise.resolve();

      const dump = dumpInternalScheduler();
      expect(dump.entries[0].fireCount).toBe(1);
      expect(dump.entries[0].errorCount).toBe(1);
      expect(dump.entries[0].lastError).toBe('HTTP 500');
      // Schedule was re-armed for the next fire (entry still present, timer set)
      expect(dump.entries[0].nextFireMs).toBeGreaterThan(Date.now());
    });

    it('pause stops future fires until resume is called', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      setSchedulerBaseUrl('http://test');

      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'x', enabled: true });
      pauseInternalScheduler();

      vi.advanceTimersByTime(60_000 + 100);
      expect(fetchMock).not.toHaveBeenCalled();

      resumeInternalScheduler();
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      for (let _i = 0; _i < 20; _i++) await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});

// ── Issue-branch skip behavior ────────────────────────────────────────────────
// These tests need to mock @/lib/project-branch-lock, so they live in a
// separate describe that resets modules and uses vi.doMock.

describe('internal-scheduler — issue-branch skip', () => {
  let upsertAgentScheduleDynamic: typeof import('@/lib/internal-scheduler').upsertAgentSchedule;
  let dumpInternalSchedulerDynamic: typeof import('@/lib/internal-scheduler').dumpInternalScheduler;
  let stopInternalSchedulerDynamic: typeof import('@/lib/internal-scheduler').stopInternalScheduler;
  let setSchedulerBaseUrlDynamic: typeof import('@/lib/internal-scheduler').setSchedulerBaseUrl;
  let getIssueBranchLockMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    getIssueBranchLockMock = vi.fn().mockResolvedValue(null);
    vi.doMock('@/lib/project-branch-lock', () => ({
      getIssueBranchLock: getIssueBranchLockMock,
    }));
    // Stub pipeline-lock so the statically-imported getLock doesn't hit the
    // real DB-backed module under test (vi.resetModules() + vi.doMock() before
    // the dynamic import causes the static import to be re-evaluated with the mock).
    vi.doMock('@/lib/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
    }));

    const mod = await import('@/lib/internal-scheduler');
    upsertAgentScheduleDynamic = mod.upsertAgentSchedule;
    dumpInternalSchedulerDynamic = mod.dumpInternalScheduler;
    stopInternalSchedulerDynamic = mod.stopInternalScheduler;
    setSchedulerBaseUrlDynamic = mod.setSchedulerBaseUrl;

    stopInternalSchedulerDynamic();
  });

  afterEach(() => {
    stopInternalSchedulerDynamic();
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('skips fire and increments skippedCount when an issue branch is active', async () => {
    getIssueBranchLockMock.mockResolvedValue('fix/issue-5-in-progress');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries[0].skippedCount).toBe(1);
    expect(dump.entries[0].lastSkippedReason).toContain('fix/issue-5-in-progress');
    expect(dump.entries[0].fireCount).toBe(0);
  });

  it('re-arms the timer after a skip so the next tick re-checks', async () => {
    getIssueBranchLockMock.mockResolvedValue('fix/issue-5-in-progress');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    // Timer should have been re-armed — entry still present with a future nextFireMs
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries).toHaveLength(1);
    expect(dump.entries[0].nextFireMs).toBeGreaterThan(Date.now());
  });

  it('fires normally when getIssueBranchLock returns null', async () => {
    getIssueBranchLockMock.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries[0].skippedCount).toBe(0);
    expect(dump.entries[0].fireCount).toBe(1);
  });

  it('fires normally when getIssueBranchLock throws (detection failure is non-fatal)', async () => {
    getIssueBranchLockMock.mockRejectedValue(new Error('git timeout'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries[0].skippedCount).toBe(0);
    expect(dump.entries[0].fireCount).toBe(1);
  });
});
