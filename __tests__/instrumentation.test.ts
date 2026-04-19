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

describe('instrumentation register()', () => {
  let installAgentScheduleMock: ReturnType<typeof vi.fn>;
  let originalRuntime: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    installAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    originalRuntime = process.env.NEXT_RUNTIME;
  });

  afterEach(() => {
    process.env.NEXT_RUNTIME = originalRuntime;
    vi.resetModules();
  });

  it('does nothing when NEXT_RUNTIME is not "nodejs"', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    const chainedDb = makeChainedDb([makeAgent()]);
    vi.doMock('@/lib/db', () => ({ db: { select: chainedDb.select }, schema: { agents: {} } }));
    vi.doMock('@/lib/agent-scheduler', () => ({ installAgentSchedule: installAgentScheduleMock }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(), eq: vi.fn(), and: vi.fn() }));

    const { register } = await import('@/instrumentation');
    await register();

    expect(installAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('reinstalls all enabled agents with schedules on startup', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const agents = [
      makeAgent({ id: 'agent-1', name: 'A', project: 'proj1', schedule: '2h', runner: 'pm2', prompt: 'a' }),
      makeAgent({ id: 'agent-2', name: 'B', project: 'proj2', schedule: '30m', runner: 'launchctl', prompt: 'b' }),
    ];
    const chainedDb = makeChainedDb(agents);
    vi.doMock('@/lib/db', () => ({ db: { select: chainedDb.select }, schema: { agents: { schedule: 'schedule', enabled: 'enabled' } } }));
    vi.doMock('@/lib/agent-scheduler', () => ({ installAgentSchedule: installAgentScheduleMock }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((a, b) => b), and: vi.fn((...args) => args) }));

    const { register } = await import('@/instrumentation');
    await register();

    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
    expect(installAgentScheduleMock).toHaveBeenCalledWith('agent-1', '2h', 'a', 'pm2', 'proj1', 'A');
    expect(installAgentScheduleMock).toHaveBeenCalledWith('agent-2', '30m', 'b', 'launchctl', 'proj2', 'B');
  });

  it('skips agents where schedule is null despite the DB filter', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    // Even if the DB returns an agent with null schedule (shouldn't happen in prod but tests the null guard)
    const agents = [makeAgent({ id: 'no-sched', schedule: null })];
    const chainedDb = makeChainedDb(agents);
    vi.doMock('@/lib/db', () => ({ db: { select: chainedDb.select }, schema: { agents: { schedule: 'schedule', enabled: 'enabled' } } }));
    vi.doMock('@/lib/agent-scheduler', () => ({ installAgentSchedule: installAgentScheduleMock }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((a, b) => b), and: vi.fn((...args) => args) }));

    const { register } = await import('@/instrumentation');
    await register();

    expect(installAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('continues processing remaining agents when one reinstall throws', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const agents = [
      makeAgent({ id: 'agent-fail', name: 'Bad', project: 'p1', schedule: '1h', prompt: 'x' }),
      makeAgent({ id: 'agent-ok', name: 'Good', project: 'p2', schedule: '2h', prompt: 'y' }),
    ];
    const chainedDb = makeChainedDb(agents);
    vi.doMock('@/lib/db', () => ({ db: { select: chainedDb.select }, schema: { agents: { schedule: 'schedule', enabled: 'enabled' } } }));
    vi.doMock('@/lib/agent-scheduler', () => ({ installAgentSchedule: installAgentScheduleMock }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((a, b) => b), and: vi.fn((...args) => args) }));

    installAgentScheduleMock
      .mockRejectedValueOnce(new Error('pm2 not found'))
      .mockResolvedValueOnce(undefined);

    const { register } = await import('@/instrumentation');
    await expect(register()).resolves.not.toThrow();
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no enabled agents exist', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const chainedDb = makeChainedDb([]);
    vi.doMock('@/lib/db', () => ({ db: { select: chainedDb.select }, schema: { agents: { schedule: 'schedule', enabled: 'enabled' } } }));
    vi.doMock('@/lib/agent-scheduler', () => ({ installAgentSchedule: installAgentScheduleMock }));
    vi.doMock('drizzle-orm', () => ({ isNotNull: vi.fn(v => v), eq: vi.fn((a, b) => b), and: vi.fn((...args) => args) }));

    const { register } = await import('@/instrumentation');
    await register();

    expect(installAgentScheduleMock).not.toHaveBeenCalled();
  });
});
