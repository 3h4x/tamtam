import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'My Agent',
    project: 'proj1',
    prompt: 'do stuff',
    schedule: '1h',
    runner: 'pm2',
    enabled: 1,
    ...overrides,
  };
}

function makeChainedDb(agents: unknown[]) {
  const all = vi.fn().mockReturnValue(agents);
  const where = vi.fn().mockReturnValue({ all });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, where, all };
}

describe('instrumentation', () => {
  let installAgentScheduleMock: ReturnType<typeof vi.fn>;
  let isAgentScheduleLoadedMock: ReturnType<typeof vi.fn>;
  let originalRuntime: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    installAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    isAgentScheduleLoadedMock = vi.fn().mockResolvedValue(false);
    originalRuntime = process.env.NEXT_RUNTIME;
  });

  afterEach(() => {
    process.env.NEXT_RUNTIME = originalRuntime;
    vi.resetModules();
  });

  function mockDeps(agents: unknown[]) {
    const chainedDb = makeChainedDb(agents);
    vi.doMock('@/lib/db', () => ({ db: { select: chainedDb.select }, schema: { agents: { schedule: 'schedule', enabled: 'enabled' } } }));
    vi.doMock('@/lib/agent-scheduler', () => ({
      installAgentSchedule: installAgentScheduleMock,
      isAgentScheduleLoaded: isAgentScheduleLoadedMock,
    }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((_a, b) => b), and: vi.fn((...args) => args) }));
  }

  describe('register()', () => {
    it('does nothing when NEXT_RUNTIME is not "nodejs"', async () => {
      process.env.NEXT_RUNTIME = 'edge';
      mockDeps([makeAgent()]);

      const { register } = await import('@/instrumentation');
      await register();
      await new Promise((r) => setImmediate(r));

      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('fires reinstall in the background without blocking', async () => {
      process.env.NEXT_RUNTIME = 'nodejs';
      mockDeps([makeAgent({ id: 'agent-1', name: 'A', project: 'proj1', schedule: '2h', prompt: 'a' })]);

      const { register } = await import('@/instrumentation');
      const returned = register();
      // register() resolves synchronously; the reinstall promise keeps running.
      await returned;
      // Flush microtasks so the fire-and-forget loop completes.
      await new Promise((r) => setImmediate(r));

      expect(installAgentScheduleMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('reinstallAgents()', () => {
    it('reinstalls all enabled agents with schedules on startup', async () => {
      process.env.NEXT_RUNTIME = 'nodejs';
      const agents = [
        makeAgent({ id: 'agent-1', name: 'A', project: 'proj1', schedule: '2h', runner: 'pm2', prompt: 'a' }),
        makeAgent({ id: 'agent-2', name: 'B', project: 'proj2', schedule: '30m', runner: 'launchctl', prompt: 'b' }),
      ];
      mockDeps(agents);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
      expect(installAgentScheduleMock).toHaveBeenCalledWith('agent-1', '2h', 'a', 'pm2', 'proj1', 'A');
      expect(installAgentScheduleMock).toHaveBeenCalledWith('agent-2', '30m', 'b', 'launchctl', 'proj2', 'B');
    });

    it('skips agents where schedule is null despite the DB filter', async () => {
      mockDeps([makeAgent({ id: 'no-sched', schedule: null })]);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('skips agents whose pm2/launchctl entry is already loaded (HMR re-run)', async () => {
      isAgentScheduleLoadedMock.mockResolvedValue(true);
      mockDeps([makeAgent({ id: 'agent-loaded', schedule: '1h' })]);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(isAgentScheduleLoadedMock).toHaveBeenCalledOnce();
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('continues processing remaining agents when one reinstall throws', async () => {
      const agents = [
        makeAgent({ id: 'agent-fail', name: 'Bad', project: 'p1', schedule: '1h', prompt: 'x' }),
        makeAgent({ id: 'agent-ok', name: 'Good', project: 'p2', schedule: '2h', prompt: 'y' }),
      ];
      mockDeps(agents);
      installAgentScheduleMock
        .mockRejectedValueOnce(new Error('pm2 not found'))
        .mockResolvedValueOnce(undefined);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await expect(reinstallAgents()).resolves.not.toThrow();
      expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
    });

    it('does nothing when no enabled agents exist', async () => {
      mockDeps([]);

      const { reinstallAgents } = await import('@/instrumentation-node');
      await reinstallAgents();

      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });
  });
});
