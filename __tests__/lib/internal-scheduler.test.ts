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
} from '@/lib/scheduling/internal-scheduler';

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

    it('remove-while-in-flight does not re-arm a zombie timer', async () => {
      // fetch hangs until we resolve it manually
      let resolveFetch!: (value: Response) => void;
      const hangingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(hangingFetch));
      setSchedulerBaseUrl('http://test');

      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'do', enabled: true });

      // Advance past the schedule window so fire() starts and awaits fetch
      await vi.advanceTimersByTimeAsync(60_000 + 100);

      // Remove the entry while fire() is still awaiting the response
      removeAgentSchedule('a1');
      expect(dumpInternalScheduler().entries).toHaveLength(0);

      // Now let the fetch resolve — fire()'s finally block calls armNext()
      resolveFetch({ ok: true } as Response);
      // Drain microtasks so the finally block runs
      for (let i = 0; i < 20; i++) await Promise.resolve();

      // armNext must have bailed on the entries.has() guard — no zombie entry
      expect(dumpInternalScheduler().entries).toHaveLength(0);

      // Advance another full interval to confirm no zombie timer fires
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('upsert with enabled=false is a no-op (no entry, no timer)', () => {
      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'x', enabled: false });
      expect(dumpInternalScheduler().entries).toHaveLength(0);
    });

    it('upsert with null/empty schedule is a no-op', () => {
      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '' as string, prompt: 'x', enabled: true });
      expect(dumpInternalScheduler().entries).toHaveLength(0);
    });

    it('rejects invalid schedules instead of arming them', () => {
      expect(() => upsertAgentSchedule({
        id: 'a1', project: 'p', name: 'n', schedule: '1w', prompt: 'x', enabled: true,
      })).toThrow('Invalid schedule');
      expect(dumpInternalScheduler().entries).toHaveLength(0);
    });
  });

  describe('overdue-aware initial arm', () => {
    afterEach(() => {
      vi.resetModules();
    });

    it('fires almost immediately when the DB shows the agent is overdue (regression: restarts must not push fire times forward)', async () => {
      // Simulate: a 30m agent whose last successful run finished 90m ago.
      // Without the fix, armNext would set nextFireMs = now + 30m and a
      // server restart every <30m would silently never fire it. With the
      // fix, computeNextFire is anchored on the last run, so the next
      // slot lands in the past and the timer is clamped to ~1s.
      vi.resetModules();
      const ninetyMinAgoSec = (Date.now() - 90 * 60_000) / 1000;
      const getMock = vi.fn().mockReturnValue({ finishedAt: ninetyMinAgoSec });
      const limitMock = vi.fn().mockReturnValue({ get: getMock });
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      const selectMock = vi.fn().mockReturnValue({ from: fromMock });
      vi.doMock('@/lib/db', () => ({
        db: { select: selectMock },
        schema: { jobs: { project: 'project', kind: 'kind', finishedAt: 'finished_at' } },
      }));

      const mod = await import('@/lib/scheduling/internal-scheduler');
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      mod.setSchedulerBaseUrl('http://test');

      mod.upsertAgentSchedule({ id: 'a-overdue', project: 'p', name: 'n', schedule: '30m', prompt: 'go', enabled: true });

      // The lookup must have happened (the fix's whole point).
      expect(getMock).toHaveBeenCalled();

      // Overdue: nextFireMs is in the future but bounded by the spread
      // window (≤ 30s + 5min). It is NOT in the past — that would be a
      // boot-stampede. And it's NOT 30 minutes — that would be the
      // restart-resets-clock bug.
      const dump = mod.dumpInternalScheduler();
      const entry = dump.entries.find(e => e.agentId === 'a-overdue');
      expect(entry).toBeDefined();
      const minutesFromNow = (entry!.nextFireMs - Date.now()) / 60_000;
      expect(minutesFromNow).toBeGreaterThan(0);          // not stampede
      expect(minutesFromNow).toBeLessThan(6);             // within spread+floor
      expect(minutesFromNow).toBeLessThan(30 - 1);        // not pushed-to-next-period

      // Advance past the maximum spread window; the agent must fire.
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      for (let _i = 0; _i < 20; _i++) await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledOnce();

      mod.stopInternalScheduler();
    });

    it('still fires at next-period when the agent is fresh (last run within the period)', async () => {
      vi.resetModules();
      const oneMinAgoSec = (Date.now() - 60_000) / 1000;
      const getMock = vi.fn().mockReturnValue({ finishedAt: oneMinAgoSec });
      const limitMock = vi.fn().mockReturnValue({ get: getMock });
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      const selectMock = vi.fn().mockReturnValue({ from: fromMock });
      vi.doMock('@/lib/db', () => ({
        db: { select: selectMock },
        schema: { jobs: { project: 'project', kind: 'kind', finishedAt: 'finished_at' } },
      }));

      const mod = await import('@/lib/scheduling/internal-scheduler');
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      mod.setSchedulerBaseUrl('http://test');

      mod.upsertAgentSchedule({ id: 'a-fresh', project: 'p', name: 'n', schedule: '30m', prompt: 'go', enabled: true });

      const dump = mod.dumpInternalScheduler();
      const entry = dump.entries.find(e => e.agentId === 'a-fresh')!;
      // Next fire should be ~29 minutes from now (30m - 1m elapsed).
      const minutesFromNow = (entry.nextFireMs - Date.now()) / 60_000;
      expect(minutesFromNow).toBeGreaterThan(28);
      expect(minutesFromNow).toBeLessThan(30);

      mod.stopInternalScheduler();
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

    it('skips invalid schedules during boot-time install', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      startInternalScheduler([
        { id: 'a1', project: 'p1', name: 'bad', schedule: '1w', prompt: 'x', enabled: true },
        { id: 'a2', project: 'p2', name: 'good', schedule: '2h', prompt: 'y', enabled: true },
      ]);

      const after = dumpInternalScheduler();
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0].agentId).toBe('a2');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping p1/bad'));
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

    it('removes stale schedules when the agent endpoint returns 404', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal('fetch', fetchMock);
      setSchedulerBaseUrl('http://test');

      upsertAgentSchedule({ id: 'a1', project: 'p', name: 'n', schedule: '1m', prompt: 'x', enabled: true });

      await vi.advanceTimersByTimeAsync(60_000 + 100);
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(dumpInternalScheduler().entries).toHaveLength(0);
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
// These tests need to mock @/lib/shared/project-branch-lock, so they live in a
// separate describe that resets modules and uses vi.doMock.

describe('internal-scheduler — issue-branch skip', () => {
  let upsertAgentScheduleDynamic: typeof import('@/lib/scheduling/internal-scheduler').upsertAgentSchedule;
  let dumpInternalSchedulerDynamic: typeof import('@/lib/scheduling/internal-scheduler').dumpInternalScheduler;
  let stopInternalSchedulerDynamic: typeof import('@/lib/scheduling/internal-scheduler').stopInternalScheduler;
  let setSchedulerBaseUrlDynamic: typeof import('@/lib/scheduling/internal-scheduler').setSchedulerBaseUrl;
  let getIssueBranchLockMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    getIssueBranchLockMock = vi.fn().mockResolvedValue(null);
    vi.doMock('@/lib/shared/project-branch-lock', () => ({
      getIssueBranchLock: getIssueBranchLockMock,
    }));
    // Stub pipeline-lock so the statically-imported getLock doesn't hit the
    // real DB-backed module under test (vi.resetModules() + vi.doMock() before
    // the dynamic import causes the static import to be re-evaluated with the mock).
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
    }));
    // Without this, the scheduler's budget gate calls into the real
    // `getSettings()` (which reads the project's production DB) and, if
    // `budget_block_runs_enabled` is on, fires a real fetch to the Anthropic
    // usage API with the user's actual OAuth token from ~/.claude. That
    // both leaks the token into test output and makes assertions about
    // `fetchMock` flaky.
    vi.doMock('@/lib/shared/job-control', () => ({
      budgetBlockedResult: vi.fn().mockReturnValue(null),
      scheduledBurnRateBlocked: vi.fn().mockReturnValue(null),
    }));
    // The scheduler now anchors initial nextFireMs on the DB-recorded last
    // fire time. Without mocking @/lib/db here, the test would hit the real
    // production DB and a stale `agent:tests` row would back-date nextFireMs
    // into the past, causing the timer to fire ~60 times during the 60s
    // vi.advanceTimersByTimeAsync window. Stub to "no last run".
    vi.doMock('@/lib/db', () => ({
      db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ get: () => undefined }) }) }) }) }) },
      schema: { jobs: { project: 'project', kind: 'kind', finishedAt: 'finished_at' } },
    }));

    const mod = await import('@/lib/scheduling/internal-scheduler');
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

describe('internal-scheduler — budget skip', () => {
  let upsertAgentScheduleDynamic: typeof import('@/lib/scheduling/internal-scheduler').upsertAgentSchedule;
  let dumpInternalSchedulerDynamic: typeof import('@/lib/scheduling/internal-scheduler').dumpInternalScheduler;
  let stopInternalSchedulerDynamic: typeof import('@/lib/scheduling/internal-scheduler').stopInternalScheduler;
  let setSchedulerBaseUrlDynamic: typeof import('@/lib/scheduling/internal-scheduler').setSchedulerBaseUrl;
  let budgetBlockedResultMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    budgetBlockedResultMock = vi.fn().mockReturnValue(null);
    vi.doMock('@/lib/shared/job-control', () => ({
      budgetBlockedResult: budgetBlockedResultMock,
      scheduledBurnRateBlocked: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shared/project-branch-lock', () => ({
      getIssueBranchLock: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
    }));
    // Stub the DB lookup so the new "anchored on last run" arming uses
    // "now" (no last run) and arms a single timer at +1m, not a flood of
    // 1s retries against a stale production row. See the issue-branch
    // skip describe for the same workaround.
    vi.doMock('@/lib/db', () => ({
      db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ get: () => undefined }) }) }) }) }) },
      schema: { jobs: { project: 'project', kind: 'kind', finishedAt: 'finished_at' } },
    }));

    const mod = await import('@/lib/scheduling/internal-scheduler');
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

  it('skips scheduled fire when the subscription budget gate is closed', async () => {
    budgetBlockedResultMock.mockReturnValue({
      ok: false,
      status: 429,
      detail: 'Codex model credit gate blocked (100%).',
      window: 'credits',
      utilization: 100,
      resetsAt: null,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries[0].skippedCount).toBe(1);
    expect(dump.entries[0].lastSkippedReason).toContain('Codex model credit gate blocked');
    expect(dump.entries[0].errorCount).toBe(0);
  });

  it('treats route-level HTTP 429 as a skip, not a scheduler error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn().mockResolvedValue({ detail: 'Codex quota exceeded' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries[0].skippedCount).toBe(1);
    expect(dump.entries[0].lastSkippedReason).toContain('Codex quota exceeded');
    expect(dump.entries[0].errorCount).toBe(0);
  });

  it('treats route-level HTTP 409 as a skip, not a scheduler error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ detail: "Agent 'tests' is already running (job job-1)" }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries[0].skippedCount).toBe(1);
    expect(dump.entries[0].lastSkippedReason).toContain('already running');
    expect(dump.entries[0].errorCount).toBe(0);
  });

  it('removes stale schedules when the route says the scheduled agent is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ detail: "Agent 'tests' is disabled — ignoring scheduled trigger" }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dumpInternalSchedulerDynamic().entries).toHaveLength(0);
  });

  it('removes stale schedules when the route says the scheduled agent has no schedule', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ detail: "Agent 'tests' has no schedule — ignoring scheduled trigger" }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dumpInternalSchedulerDynamic().entries).toHaveLength(0);
  });

  it('pauses the scheduler when the route reports jobs are paused globally', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ detail: 'Jobs are paused globally. Turn the switch back on in Settings to start an agent run.' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.paused).toBe(true);
    expect(dump.entries[0].errorCount).toBe(1);
    expect(dump.entries[0].lastError).toContain('Jobs are paused globally');
    expect(dump.entries[0].skippedCount).toBe(0);
  });

  it('treats unknown route-level HTTP 409 conflicts as scheduler errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ detail: 'Unexpected conflict while starting agent run' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSchedulerBaseUrlDynamic('http://test');

    upsertAgentScheduleDynamic({ id: 'a1', project: 'myproj', name: 'tests', schedule: '1m', prompt: 'run tests', enabled: true });

    await vi.advanceTimersByTimeAsync(60_000 + 100);
    for (let _i = 0; _i < 20; _i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const dump = dumpInternalSchedulerDynamic();
    expect(dump.entries[0].errorCount).toBe(1);
    expect(dump.entries[0].lastError).toContain('Unexpected conflict');
    expect(dump.entries[0].skippedCount).toBe(0);
  });
});
