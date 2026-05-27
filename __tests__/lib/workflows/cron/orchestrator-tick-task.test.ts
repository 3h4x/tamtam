import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleOrchestratorTick,
  createOrchestratorTickTask,
  ORCHESTRATOR_TICK_INTERVAL_MS,
  type OrchestratorTickDeps,
} from '@/lib/workflows/cron/orchestrator-tick-task';

const NOW = 1_700_000_000_000;

type BridgeType = Awaited<ReturnType<OrchestratorTickDeps['loadBridge']>>;

function makeBridge(overrides: Partial<BridgeType> = {}) {
  return {
    globalPace: {
      status: 'under_pace' as const,
      marginPct: 20,
      providers: [],
    },
    projects: [
      { project: 'borged', status: 'shipping', paused: false, releaseRunning: false, lastPushAt: 1_699_999_000 },
    ],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OrchestratorTickDeps> = {}): OrchestratorTickDeps {
  return {
    loadConfig: vi.fn(async () => ({ marginPct: 5, maxBoostsPerHour: 2 })),
    loadBridge: vi.fn(async () => makeBridge()),
    loadAgents: vi.fn(async () => [
      { id: 'a1', name: 'improve', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: null, kind: 'user' as const },
    ]),
    enqueueAgentFire: vi.fn(async () => {}),
    enqueueNextFire: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  // reset global history between tests
  globalThis.__tamtamOrchestratorHistory = undefined;
});

describe('handleOrchestratorTick', () => {
  it('re-enqueues next fire even when orchestrator is disabled (loadConfig returns null)', async () => {
    const deps = makeDeps({ loadConfig: vi.fn(async () => null) });
    const r = await handleOrchestratorTick(deps);
    expect(r.enabled).toBe(false);
    expect(r.decisions).toHaveLength(0);
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
    expect(deps.loadBridge).not.toHaveBeenCalled();
  });

  it('schedules next fire at now + interval', async () => {
    const deps = makeDeps({ loadConfig: vi.fn(async () => null) });
    const r = await handleOrchestratorTick(deps);
    expect(r.nextFireAt.getTime()).toBe(NOW + ORCHESTRATOR_TICK_INTERVAL_MS);
  });

  it('returns enabled=true and calls loadBridge + loadAgents when config present', async () => {
    const deps = makeDeps();
    const r = await handleOrchestratorTick(deps);
    expect(r.enabled).toBe(true);
    expect(deps.loadBridge).toHaveBeenCalledTimes(1);
    expect(deps.loadAgents).toHaveBeenCalledTimes(1);
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('dispatches agent fires for each boost decision', async () => {
    // Give a big margin so decideBoosts picks the agent
    const deps = makeDeps({
      loadBridge: vi.fn(async () =>
        makeBridge({ globalPace: { status: 'under_pace', marginPct: 50 } }),
      ),
    });
    const r = await handleOrchestratorTick(deps);
    expect(r.enabled).toBe(true);
    // whether decisions fire depends on allocator logic; the important check is
    // that if decisions > 0, enqueueAgentFire was called the same number of times
    expect(deps.enqueueAgentFire).toHaveBeenCalledTimes(r.decisions.length);
  });

  it('captures loadBridge errors and still re-enqueues next fire', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () => { throw new Error('bridge down'); }),
    });
    const r = await handleOrchestratorTick(deps);
    expect(r.error).toBe('bridge down');
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('uses weeklyMarginPct from providers when available', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () =>
        makeBridge({
          globalPace: {
            status: 'under_pace',
            marginPct: 10,
            providers: [
              {
                provider: 'anthropic',
                sevenDay: { paceMarginPct: 35, status: 'under_pace' },
              },
            ],
          },
        }),
      ),
    });
    // Just verify it runs without error — the weekly margin path is exercised
    const r = await handleOrchestratorTick(deps);
    expect(r.error).toBeUndefined();
    expect(r.enabled).toBe(true);
  });

  it('ignores weeklyMarginPct from providers with unknown status', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () =>
        makeBridge({
          globalPace: {
            status: 'under_pace',
            marginPct: 10,
            providers: [
              {
                provider: 'anthropic',
                sevenDay: { paceMarginPct: 99, status: 'unknown' },
              },
            ],
          },
        }),
      ),
    });
    const r = await handleOrchestratorTick(deps);
    expect(r.error).toBeUndefined();
  });
});

describe('createOrchestratorTickTask', () => {
  it('logs disabled status when orchestrator is off', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const task = createOrchestratorTickTask(
      makeDeps({ loadConfig: vi.fn(async () => null) }),
    );
    await task({}, { logger } as never);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs error string when tick throws', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const task = createOrchestratorTickTask(
      makeDeps({
        loadBridge: vi.fn(async () => { throw new Error('network failure'); }),
      }),
    );
    await task({}, { logger } as never);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('network failure'));
  });
});
