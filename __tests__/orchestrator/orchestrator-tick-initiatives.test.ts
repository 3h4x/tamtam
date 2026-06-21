import { describe, it, expect, vi } from 'vitest';
import { handleOrchestratorTick, type OrchestratorTickDeps } from '@/lib/workflows/cron/orchestrator-tick-task';

function baseDeps(over: Partial<OrchestratorTickDeps>): OrchestratorTickDeps {
  return {
    loadConfig: async () => ({ marginPct: 5, maxBoostsPerHour: 2 }),
    loadBridge: async () => ({
      globalPace: { status: 'on_pace', marginPct: 10, providers: [] },
      projects: [],
    }),
    loadAgents: async () => [],
    enqueueAgentFire: async () => {},
    enqueueNextFire: async () => {},
    now: () => 1000,
    ...over,
  };
}

describe('orchestrator tick — initiative phases', () => {
  it('runs mine + dispatch when the engine is enabled', async () => {
    const mineInitiatives = vi.fn(async () => {});
    const dispatchInitiatives = vi.fn(async () => {});
    await handleOrchestratorTick(baseDeps({
      initiativeEngineEnabled: () => true, mineInitiatives, dispatchInitiatives,
    }));
    expect(mineInitiatives).toHaveBeenCalledTimes(1);
    expect(dispatchInitiatives).toHaveBeenCalledTimes(1);
  });

  it('runs initiative phases when boost allocation is disabled but initiative engine is enabled', async () => {
    const mineInitiatives = vi.fn(async () => {});
    const dispatchInitiatives = vi.fn(async () => {});
    const res = await handleOrchestratorTick(baseDeps({
      loadConfig: async () => null,
      initiativeEngineEnabled: () => true,
      mineInitiatives,
      dispatchInitiatives,
    }));
    expect(res.enabled).toBe(true);
    expect(mineInitiatives).toHaveBeenCalledTimes(1);
    expect(dispatchInitiatives).toHaveBeenCalledTimes(1);
  });

  it('skips initiative phases when the engine is disabled', async () => {
    const mineInitiatives = vi.fn(async () => {});
    const dispatchInitiatives = vi.fn(async () => {});
    await handleOrchestratorTick(baseDeps({
      initiativeEngineEnabled: () => false, mineInitiatives, dispatchInitiatives,
    }));
    expect(mineInitiatives).not.toHaveBeenCalled();
    expect(dispatchInitiatives).not.toHaveBeenCalled();
  });

  it('a throwing mine phase does not break the tick', async () => {
    const res = await handleOrchestratorTick(baseDeps({
      initiativeEngineEnabled: () => true,
      mineInitiatives: async () => { throw new Error('boom'); },
      dispatchInitiatives: vi.fn(async () => {}),
    }));
    expect(res.enabled).toBe(true);
  });

  it('awaits an async initiativeEngineEnabled (wiring loads settings via await import)', async () => {
    const mineInitiatives = vi.fn(async () => {});
    const dispatchInitiatives = vi.fn(async () => {});
    await handleOrchestratorTick(baseDeps({
      initiativeEngineEnabled: async () => true,
      mineInitiatives,
      dispatchInitiatives,
    }));
    expect(mineInitiatives).toHaveBeenCalledTimes(1);
    expect(dispatchInitiatives).toHaveBeenCalledTimes(1);
  });

  it('does not run phases when async initiativeEngineEnabled resolves false', async () => {
    const mineInitiatives = vi.fn(async () => {});
    await handleOrchestratorTick(baseDeps({
      initiativeEngineEnabled: async () => false,
      mineInitiatives,
      dispatchInitiatives: vi.fn(async () => {}),
    }));
    expect(mineInitiatives).not.toHaveBeenCalled();
  });
});
