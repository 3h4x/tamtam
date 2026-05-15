import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock graphile-worker before importing the SUT so quickAddJob is a stub.
// vi.hoisted() lets the mock factory reference our shared ref without
// hitting "Cannot access before initialization" (vi.mock hoists above all
// imports including the const declaration).
const { quickAddJobMock } = vi.hoisted(() => ({ quickAddJobMock: vi.fn() }));
vi.mock('graphile-worker', () => ({
  quickAddJob: quickAddJobMock,
}));

import { seedAgentCrons } from '@/lib/workflows/cron/seed-agent-crons';
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

describe('seedAgentCrons', () => {
  beforeEach(() => {
    quickAddJobMock.mockClear().mockResolvedValue(undefined);
  });

  it('enqueues one agent-cron job per enabled agent with stable jobKey', async () => {
    const r = await seedAgentCrons({
      connectionString: 'postgres://stub',
      loadEnabledAgents: async () => [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })],
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
    });
    expect(r.enqueued).toBe(1);
    expect(r.skipped).toEqual([{ agentId: 'dead', reason: 'disabled' }]);
  });

  it('skips agents with no schedule', async () => {
    const r = await seedAgentCrons({
      connectionString: 'postgres://stub',
      loadEnabledAgents: async () => [makeAgent({ id: 'no-sched', schedule: null })],
    });
    expect(r.enqueued).toBe(0);
    expect(r.skipped).toEqual([{ agentId: 'no-sched', reason: 'no schedule' }]);
  });

  it('records enqueue failures in skipped instead of throwing', async () => {
    quickAddJobMock.mockRejectedValueOnce(new Error('pg connection refused'));
    const r = await seedAgentCrons({
      connectionString: 'postgres://stub',
      loadEnabledAgents: async () => [makeAgent()],
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
});
