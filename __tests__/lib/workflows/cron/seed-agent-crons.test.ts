import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock graphile-worker before importing the SUT so quickAddJob is a stub.
// vi.hoisted() lets the mock factory reference our shared ref without
// hitting "Cannot access before initialization" (vi.mock hoists above all
// imports including the const declaration).
const { quickAddJobMock } = vi.hoisted(() => ({ quickAddJobMock: vi.fn() }));
vi.mock('graphile-worker', () => ({
  quickAddJob: quickAddJobMock,
}));

import { seedAgentCrons, type ExistingAgentCronJob } from '@/lib/workflows/cron/seed-agent-crons';
import type { AgentInput } from '@/lib/scheduling/agent-types';

function makeAgent(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    id: 'a1',
    name: 'workflow-rw',
    project: 'p',
    schedule: '1h',
    prompt: 'do',
    enabled: true,
    ...overrides,
  } as AgentInput;
}

function existingJob(runAt: number | Date, overrides: Partial<ExistingAgentCronJob> = {}): ExistingAgentCronJob {
  return {
    runAt: runAt instanceof Date ? runAt : new Date(runAt),
    attempts: 0,
    maxAttempts: 5,
    lockedAt: null,
    isAvailable: true,
    ...overrides,
  };
}

describe('seedAgentCrons', () => {
  beforeEach(() => {
    quickAddJobMock.mockClear().mockResolvedValue(undefined);
  });

  // Default: no preserved rows. Tests that care about preservation pass
  // their own stub.
  const noExisting = async () => new Map<string, ExistingAgentCronJob>();
  // Default: no-op sweep. Real sweep targets pg; stubs avoid the pool.
  const noSweep = async () => undefined;

  it('enqueues one agent-cron job per enabled agent with stable jobKey', async () => {
    const r = await seedAgentCrons({
      connectionString: 'postgres://stub',
      loadEnabledAgents: async () => [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })],
      loadExistingRunAts: noExisting,
        sweepDeadOrphans: noSweep,
    });
    expect(r.enqueued).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(quickAddJobMock).toHaveBeenCalledTimes(2);
    const firstCall = quickAddJobMock.mock.calls[0];
    // vi.fn() typings are loose at the args tuple — explicitly cast for tsc.
    const args = firstCall as unknown as [unknown, string, { agentId: string }, { jobKey: string; jobKeyMode: string; runAt: Date }];
    expect(args[1]).toBe('agent-cron');
    expect(args[2]).toEqual({ agentId: 'a1' });
    expect(args[3]).toMatchObject({
      jobKey: 'agent-cron-a1',
      jobKeyMode: 'replace',
    });
    expect(args[3].runAt).toBeInstanceOf(Date);
  });

  it('skips disabled agents with a reason', async () => {
    const r = await seedAgentCrons({
      connectionString: 'postgres://stub',
      loadEnabledAgents: async () => [
        makeAgent({ id: 'live' }),
        makeAgent({ id: 'dead', enabled: false }),
      ],
      loadExistingRunAts: noExisting,
        sweepDeadOrphans: noSweep,
    });
    expect(r.enqueued).toBe(1);
    expect(r.skipped).toEqual([{ agentId: 'dead', reason: 'disabled' }]);
  });

  it('skips agents with no schedule', async () => {
    const r = await seedAgentCrons({
      connectionString: 'postgres://stub',
      loadEnabledAgents: async () => [makeAgent({ id: 'no-sched', schedule: null })],
      loadExistingRunAts: noExisting,
        sweepDeadOrphans: noSweep,
    });
    expect(r.enqueued).toBe(0);
    expect(r.skipped).toEqual([{ agentId: 'no-sched', reason: 'no schedule' }]);
  });

  it('records enqueue failures in skipped instead of throwing', async () => {
    quickAddJobMock.mockRejectedValueOnce(new Error('pg connection refused'));
    const r = await seedAgentCrons({
      connectionString: 'postgres://stub',
      loadEnabledAgents: async () => [makeAgent()],
      loadExistingRunAts: noExisting,
        sweepDeadOrphans: noSweep,
    });
    expect(r.enqueued).toBe(0);
    expect(r.skipped[0].reason).toMatch(/enqueue failed: pg connection refused/);
  });

  it('returns no-op when no postgres URL is available (env unset, no override)', async () => {
    const prevDb = process.env.DATABASE_URL;
    const prevWf = process.env.WORKFLOW_POSTGRES_URL;
    delete process.env.DATABASE_URL;
    delete process.env.WORKFLOW_POSTGRES_URL;
    try {
      const r = await seedAgentCrons({
        loadEnabledAgents: async () => [makeAgent()],
      });
      expect(r.enqueued).toBe(0);
      expect(r.skipped).toEqual([{ agentId: '*', reason: 'no postgres URL' }]);
    } finally {
      if (prevDb) process.env.DATABASE_URL = prevDb;
      if (prevWf) process.env.WORKFLOW_POSTGRES_URL = prevWf;
    }
  });

  describe('run_at preservation across restarts', () => {
    it('preserves an existing future run_at that is not later than the freshly-computed one', async () => {
      const T0 = 1_700_000_000_000;
      // existing row already enqueued at T0 + 20min, schedule "30m" so
      // fresh computation at T0 + 5min would be T0 + 35min.
      const existing = new Map([['agent-cron-a1', existingJob(T0 + 20 * 60_000)]]);
      const r = await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent({ id: 'a1', schedule: '30m' })],
        loadExistingRunAts: async () => existing,
        sweepDeadOrphans: noSweep,
        now: () => T0 + 5 * 60_000,
      });
      expect(r.enqueued).toBe(0);
      expect(r.preserved).toBe(1);
      expect(quickAddJobMock).not.toHaveBeenCalled();
    });

    it('overwrites an existing past run_at', async () => {
      const T0 = 1_700_000_000_000;
      // Existing row's run_at is already in the past — the fire was missed
      // while the worker was down. Replace it with a fresh future fire.
      const existing = new Map([['agent-cron-a1', existingJob(T0 - 60_000)]]);
      const r = await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent({ id: 'a1', schedule: '30m' })],
        loadExistingRunAts: async () => existing,
        sweepDeadOrphans: noSweep,
        now: () => T0,
      });
      expect(r.enqueued).toBe(1);
      expect(r.preserved).toBe(0);
      const call = quickAddJobMock.mock.calls[0] as unknown as [unknown, string, unknown, { runAt: Date }];
      expect(call[3].runAt.getTime()).toBe(T0 + 30 * 60_000);
    });

    it('enqueues fresh when no existing row exists', async () => {
      const T0 = 1_700_000_000_000;
      const r = await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent({ id: 'a1', schedule: '30m' })],
        loadExistingRunAts: async () => new Map(),
        sweepDeadOrphans: noSweep,
        now: () => T0,
      });
      expect(r.enqueued).toBe(1);
      expect(r.preserved).toBe(0);
    });

    it('overwrites an existing run_at that is much further out than the fresh one (e.g. orphan from old buggy compute)', async () => {
      const T0 = 1_700_000_000_000;
      // existing row a year in the future — newer compute is closer.
      const existing = new Map([['agent-cron-a1', existingJob(T0 + 365 * 86_400_000)]]);
      const r = await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent({ id: 'a1', schedule: '30m' })],
        loadExistingRunAts: async () => existing,
        sweepDeadOrphans: noSweep,
        now: () => T0,
      });
      expect(r.enqueued).toBe(1);
      expect(r.preserved).toBe(0);
    });

    it('overwrites an existing future run_at when the queued row has retry state', async () => {
      const T0 = 1_700_000_000_000;
      const existing = new Map([[
        'agent-cron-a1',
        existingJob(T0 + 20 * 60_000, { attempts: 1 }),
      ]]);
      const r = await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent({ id: 'a1', schedule: '30m' })],
        loadExistingRunAts: async () => existing,
        sweepDeadOrphans: noSweep,
        now: () => T0 + 5 * 60_000,
      });
      expect(r.enqueued).toBe(1);
      expect(r.preserved).toBe(0);
      expect(quickAddJobMock).toHaveBeenCalledTimes(1);
      const call = quickAddJobMock.mock.calls[0] as unknown as [unknown, string, unknown, { runAt: Date; jobKeyMode: string }];
      expect(call[3].jobKeyMode).toBe('replace');
      expect(call[3].runAt.getTime()).toBe(T0 + 35 * 60_000);
    });

    it('overwrites an existing future run_at when the queued row is exhausted', async () => {
      const T0 = 1_700_000_000_000;
      const existing = new Map([[
        'agent-cron-a1',
        existingJob(T0 + 20 * 60_000, {
          attempts: 5,
          maxAttempts: 5,
          isAvailable: false,
        }),
      ]]);
      const r = await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent({ id: 'a1', schedule: '30m' })],
        loadExistingRunAts: async () => existing,
        sweepDeadOrphans: noSweep,
        now: () => T0 + 5 * 60_000,
      });
      expect(r.enqueued).toBe(1);
      expect(r.preserved).toBe(0);
      expect(quickAddJobMock).toHaveBeenCalledTimes(1);
    });

    it('does not push the run_at forward across simulated restarts', async () => {
      // Reproduces the original symptom: rapid boot loop with 30m
      // schedule. The first seed sets run_at; subsequent seeds within
      // the 30m window must preserve it instead of overwriting.
      const T0 = 1_700_000_000_000;
      let queued: Date | null = null;
      quickAddJobMock.mockImplementation(async (_c, _t, _p, opts: { runAt: Date }) => {
        queued = opts.runAt;
      });
      const agents = [makeAgent({ id: 'a1', schedule: '30m' })];

      // Boot #1 at T0 — fresh seed.
      await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => agents,
        loadExistingRunAts: async () => (queued ? new Map([['agent-cron-a1', existingJob(queued)]]) : new Map()),
        sweepDeadOrphans: noSweep,
        now: () => T0,
      });
      const firstRunAt = queued!.getTime();
      expect(firstRunAt).toBe(T0 + 30 * 60_000);

      // Boot #2 at T0 + 5min — must preserve.
      await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => agents,
        loadExistingRunAts: async () => new Map([['agent-cron-a1', existingJob(queued!)]]),
        sweepDeadOrphans: noSweep,
        now: () => T0 + 5 * 60_000,
      });
      expect(queued!.getTime()).toBe(firstRunAt);

      // Boot #3 at T0 + 25min — still preserve.
      await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => agents,
        loadExistingRunAts: async () => new Map([['agent-cron-a1', existingJob(queued!)]]),
        sweepDeadOrphans: noSweep,
        now: () => T0 + 25 * 60_000,
      });
      expect(queued!.getTime()).toBe(firstRunAt);
    });
  });

  describe('dead-orphan sweep', () => {
    it('invokes the sweep on each boot', async () => {
      const sweep = vi.fn(async () => undefined);
      await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent()],
        loadExistingRunAts: noExisting,
        sweepDeadOrphans: sweep,
      });
      expect(sweep).toHaveBeenCalledOnce();
      expect(sweep).toHaveBeenCalledWith('postgres://stub');
    });

    it('continues seeding when the sweep fails', async () => {
      const sweep = vi.fn(async () => { throw new Error('pg unreachable'); });
      const r = await seedAgentCrons({
        connectionString: 'postgres://stub',
        loadEnabledAgents: async () => [makeAgent()],
        loadExistingRunAts: noExisting,
        sweepDeadOrphans: sweep,
      });
      // Sweep is best-effort; a failure must not block the seed pass.
      expect(r.enqueued).toBe(1);
      expect(sweep).toHaveBeenCalledOnce();
    });
  });
});
