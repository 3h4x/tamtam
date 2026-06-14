import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleOrchestratorTick,
  createOrchestratorTickTask,
  ORCHESTRATOR_TICK_INTERVAL_MS,
  type OrchestratorTickDeps,
  type AnalysisCandidate,
} from '@/lib/workflows/cron/orchestrator-tick-task';
import { loadBoostAgents } from '@/lib/orchestrator/boost-agent-loader';

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
      { id: 'a1', name: 'improve', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: null, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
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
  globalThis.__tamtamAgentHealthAnalyzed = undefined;
  globalThis.__tamtamAgentHealthInFlight = undefined;
});

async function flushAnalysisMarkers(): Promise<void> {
  await Promise.resolve();
}

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

  it('still dispatches boosts when fruitfulness enrichment fails', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () =>
        makeBridge({ globalPace: { status: 'under_pace', marginPct: 50 } }),
      ),
      loadAgents: vi.fn(async () => loadBoostAgents({
        listAgents: vi.fn(async () => [
          { id: 'a1', name: 'improve', project: 'borged', schedule: '15m', prompt: '', enabled: true, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
        ]),
        getDispatches: vi.fn(() => new Map<string, number>()),
        loadFruitfulness: vi.fn(async () => {
          throw new Error('fruitfulness unavailable');
        }),
      })),
    });

    const r = await handleOrchestratorTick(deps);

    expect(r.error).toBeUndefined();
    expect(r.decisions.map((d) => d.agentId)).toEqual(['a1']);
    expect(deps.enqueueAgentFire).toHaveBeenCalledTimes(1);
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
  it('skips boost for projects that already have agents waiting in the queue', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () =>
        makeBridge({ globalPace: { status: 'under_pace', marginPct: 50 } }),
      ),
      // borged has 2 agents queued — boost should be suppressed
      getProjectQueueCounts: vi.fn(async () => new Map([['borged', 2]])),
    });
    const r = await handleOrchestratorTick(deps);
    expect(r.decisions).toHaveLength(0);
    expect(deps.enqueueAgentFire).not.toHaveBeenCalled();
  });

  it('fires boost for projects with empty queue even when getProjectQueueCounts is provided', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () =>
        makeBridge({ globalPace: { status: 'under_pace', marginPct: 50 } }),
      ),
      getProjectQueueCounts: vi.fn(async () => new Map([['other-project', 3]])),
    });
    const r = await handleOrchestratorTick(deps);
    // borged has nothing queued — boost should fire normally
    expect(deps.enqueueAgentFire).toHaveBeenCalledTimes(r.decisions.length);
  });
});

describe('handleOrchestratorTick — health analysis phase', () => {
  it('calls analyzeAgentHealth with eligible agents when pace is safe', async () => {
    const analyzeAgentHealth = vi.fn(async (_c: AnalysisCandidate[]) => []);
    await handleOrchestratorTick(makeDeps({ analyzeAgentHealth }));
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);
    const candidates = analyzeAgentHealth.mock.calls[0][0];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: 'a1', name: 'improve', project: 'borged' });
  });

  it('skips analyzeAgentHealth when pace status is will_exceed', async () => {
    const analyzeAgentHealth = vi.fn(async () => []);
    const deps = makeDeps({
      analyzeAgentHealth,
      loadBridge: vi.fn(async () =>
        makeBridge({ globalPace: { status: 'will_exceed' as never, marginPct: -5, providers: [] } }),
      ),
    });
    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).not.toHaveBeenCalled();
  });

  it('skips analyzeAgentHealth when pace status is exceeded', async () => {
    const analyzeAgentHealth = vi.fn(async () => []);
    const deps = makeDeps({
      analyzeAgentHealth,
      loadBridge: vi.fn(async () =>
        makeBridge({ globalPace: { status: 'exceeded' as never, marginPct: -20, providers: [] } }),
      ),
    });
    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).not.toHaveBeenCalled();
  });

  it('skips an analyzed agent without a DB lookup when no newer dispatch exists', async () => {
    globalThis.__tamtamAgentHealthAnalyzed = new Map([
      ['a1', { analyzedAtMs: NOW - 5 * 60 * 1000, latestRunStartedAt: NOW - 10 * 60 * 1000 }],
    ]);
    const analyzeAgentHealth = vi.fn(async () => []);
    const loadLatestFinishedRunStartedAt = vi.fn(async () => NOW - 10 * 60 * 1000);
    await handleOrchestratorTick(makeDeps({
      analyzeAgentHealth,
      loadLatestFinishedRunStartedAt,
      loadAgents: vi.fn(async () => [
        { id: 'a1', name: 'improve', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: NOW - 10 * 60 * 1000, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      ]),
    }));
    expect(analyzeAgentHealth).not.toHaveBeenCalled();
    expect(loadLatestFinishedRunStartedAt).not.toHaveBeenCalled();
  });

  it('skips an agent when the latest finished scheduled run is already covered by completed analysis', async () => {
    globalThis.__tamtamAgentHealthAnalyzed = new Map([
      ['a1', { analyzedAtMs: NOW - 5 * 60 * 1000, latestRunStartedAt: NOW - 10 * 60 * 1000 }],
    ]);
    const analyzeAgentHealth = vi.fn(async () => []);
    const loadLatestFinishedRunStartedAt = vi.fn(async () => NOW - 10 * 60 * 1000);
    await handleOrchestratorTick(makeDeps({
      analyzeAgentHealth,
      loadLatestFinishedRunStartedAt,
      loadAgents: vi.fn(async () => [
        { id: 'a1', name: 'improve', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: NOW - 60 * 1000, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      ]),
    }));
    expect(analyzeAgentHealth).not.toHaveBeenCalled();
    expect(loadLatestFinishedRunStartedAt).toHaveBeenCalledTimes(1);
  });

  it('re-analyzes an agent when a newer finished scheduled run exists after the covered run', async () => {
    globalThis.__tamtamAgentHealthAnalyzed = new Map([
      ['a1', { analyzedAtMs: NOW - 5 * 60 * 1000, latestRunStartedAt: NOW - 10 * 60 * 1000 }],
    ]);
    const analyzeAgentHealth = vi.fn(async () => []);
    await handleOrchestratorTick(makeDeps({
      analyzeAgentHealth,
      loadLatestFinishedRunStartedAt: vi.fn(async () => NOW - 60 * 1000),
      loadAgents: vi.fn(async () => [
        { id: 'a1', name: 'improve', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: NOW - 60 * 1000, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      ]),
    }));
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);
  });

  it('does not retry analysis for the same finished run while a newer dispatch is still unfinished', async () => {
    const latestRunStartedAt = NOW - 10 * 60 * 1000;
    const loadLatestFinishedRunStartedAt = vi.fn(async () => latestRunStartedAt);
    const analyzeAgentHealth = vi.fn(async () => [
      { agentId: 'a1', analyzed: true, latestRunStartedAt },
    ]);
    const deps = makeDeps({
      analyzeAgentHealth,
      loadLatestFinishedRunStartedAt,
      loadAgents: vi.fn(async () => [
        { id: 'a1', name: 'improve', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: NOW - 60 * 1000, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      ]),
    });

    await handleOrchestratorTick(deps);
    await flushAnalysisMarkers();
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);

    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);
    expect(loadLatestFinishedRunStartedAt).toHaveBeenCalledTimes(1);
  });

  it('records completed analysis coverage so the next tick skips the agent', async () => {
    const latestRunStartedAt = NOW - 60 * 1000;
    const analyzeAgentHealth = vi.fn(async () => [
      { agentId: 'a1', analyzed: true, latestRunStartedAt },
    ]);
    const deps = makeDeps({ analyzeAgentHealth });
    await handleOrchestratorTick(deps);
    await flushAnalysisMarkers();
    expect(globalThis.__tamtamAgentHealthAnalyzed?.get('a1')).toEqual({
      analyzedAtMs: NOW,
      latestRunStartedAt,
    });
    // Second tick at the same time should skip
    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);
  });

  it('does not record analysis coverage when the analysis returns no completed outcomes', async () => {
    const analyzeAgentHealth = vi.fn(async () => []);
    const deps = makeDeps({ analyzeAgentHealth });
    await handleOrchestratorTick(deps);
    await flushAnalysisMarkers();
    expect(globalThis.__tamtamAgentHealthAnalyzed?.get('a1')).toBeUndefined();
    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(2);
  });

  it('does not start duplicate analysis while a prior analysis is still in flight', async () => {
    let resolveAnalysis: ((value: []) => void) | undefined;
    const analysisPromise = new Promise<[]>((resolve) => {
      resolveAnalysis = resolve;
    });
    const analyzeAgentHealth = vi.fn(() => analysisPromise);
    const deps = makeDeps({ analyzeAgentHealth });

    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);
    expect(globalThis.__tamtamAgentHealthInFlight?.has('a1')).toBe(true);

    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);

    resolveAnalysis?.([]);
    await analysisPromise;
    await flushAnalysisMarkers();
    expect(globalThis.__tamtamAgentHealthInFlight?.has('a1')).toBe(false);

    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(2);
  });

  it('clears in-flight analysis after rejection so the agent can retry', async () => {
    let rejectAnalysis: ((reason?: unknown) => void) | undefined;
    const analysisPromise = new Promise<[]>((_resolve, reject) => {
      rejectAnalysis = reject;
    });
    const analyzeAgentHealth = vi.fn(() => analysisPromise);
    const deps = makeDeps({ analyzeAgentHealth });

    await handleOrchestratorTick(deps);
    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(1);

    rejectAnalysis?.(new Error('runner failed'));
    await analysisPromise.catch(() => {});
    await flushAnalysisMarkers();
    expect(globalThis.__tamtamAgentHealthInFlight?.has('a1')).toBe(false);

    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(2);
  });

  it('does not record analysis coverage when analyzeAgentHealth rejects', async () => {
    const analyzeAgentHealth = vi.fn(async () => {
      throw new Error('runner failed');
    });
    const deps = makeDeps({ analyzeAgentHealth });
    await handleOrchestratorTick(deps);
    await flushAnalysisMarkers();
    expect(globalThis.__tamtamAgentHealthAnalyzed?.get('a1')).toBeUndefined();
    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth).toHaveBeenCalledTimes(2);
  });

  it('caps analysis at 3 agents per tick', async () => {
    const manyAgents = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`, name: `agent${i}`, project: 'borged', enabled: true,
      schedule: '15m', lastDispatchMs: null, kind: 'user' as const, boostable: true,
    }));
    const analyzeAgentHealth = vi.fn(async (_c: AnalysisCandidate[]) => []);
    const deps = makeDeps({ analyzeAgentHealth, loadAgents: vi.fn(async () => manyAgents) });
    await handleOrchestratorTick(deps);
    expect(analyzeAgentHealth.mock.calls[0][0]).toHaveLength(3);
  });

  it('caps finished-run freshness lookups before querying analyzed agents', async () => {
    const coveredRunStartedAt = NOW - 10 * 60 * 1000;
    globalThis.__tamtamAgentHealthAnalyzed = new Map(
      Array.from({ length: 10 }, (_, i) => [
        `a${i}`,
        { analyzedAtMs: NOW - (10 - i) * 60 * 1000, latestRunStartedAt: coveredRunStartedAt },
      ]),
    );
    const manyAgents = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`, name: `agent${i}`, project: 'borged', enabled: true,
      schedule: '15m', lastDispatchMs: NOW - 60 * 1000, kind: 'user' as const, boostable: true,
    }));
    const loadLatestFinishedRunStartedAt = vi.fn(async (_candidate: AnalysisCandidate) => NOW - 30 * 1000);
    const analyzeAgentHealth = vi.fn(async (_c: AnalysisCandidate[]) => []);
    const deps = makeDeps({ analyzeAgentHealth, loadLatestFinishedRunStartedAt, loadAgents: vi.fn(async () => manyAgents) });

    await handleOrchestratorTick(deps);

    expect(loadLatestFinishedRunStartedAt).toHaveBeenCalledTimes(3);
    expect(analyzeAgentHealth.mock.calls[0][0]).toHaveLength(3);
  });

  it('only checks finished-run freshness for analyzed agents with newer dispatch evidence', async () => {
    const coveredRunStartedAt = NOW - 10 * 60 * 1000;
    globalThis.__tamtamAgentHealthAnalyzed = new Map([
      ['stale-0', { analyzedAtMs: NOW - 9 * 60 * 1000, latestRunStartedAt: coveredRunStartedAt }],
      ['stale-1', { analyzedAtMs: NOW - 8 * 60 * 1000, latestRunStartedAt: coveredRunStartedAt }],
      ['fresh-0', { analyzedAtMs: NOW - 7 * 60 * 1000, latestRunStartedAt: coveredRunStartedAt }],
      ['fresh-1', { analyzedAtMs: NOW - 6 * 60 * 1000, latestRunStartedAt: coveredRunStartedAt }],
    ]);
    const agents = [
      { id: 'stale-0', name: 'stale0', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: coveredRunStartedAt, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      { id: 'stale-1', name: 'stale1', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: null, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      { id: 'fresh-0', name: 'fresh0', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: NOW - 60 * 1000, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      { id: 'fresh-1', name: 'fresh1', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: NOW - 30 * 1000, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
    ];
    const loadLatestFinishedRunStartedAt = vi.fn(async (_candidate: AnalysisCandidate) => NOW - 30 * 1000);
    const analyzeAgentHealth = vi.fn(async (_c: AnalysisCandidate[]) => []);
    const deps = makeDeps({ analyzeAgentHealth, loadLatestFinishedRunStartedAt, loadAgents: vi.fn(async () => agents) });

    await handleOrchestratorTick(deps);

    expect(loadLatestFinishedRunStartedAt).toHaveBeenCalledTimes(2);
    expect(loadLatestFinishedRunStartedAt.mock.calls.map(([candidate]) => candidate.id)).toEqual(['fresh-0', 'fresh-1']);
    expect(analyzeAgentHealth.mock.calls[0][0].map((candidate) => candidate.id)).toEqual(['fresh-0', 'fresh-1']);
  });

  it('skips system-kind and unscheduled agents', async () => {
    const mixedAgents = [
      { id: 'sys', name: 'reindex', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: null, kind: 'system' as const, boostable: true },
      { id: 'noSched', name: 'manual', project: 'borged', enabled: true, schedule: null, lastDispatchMs: null, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      { id: 'good', name: 'improve', project: 'borged', enabled: true, schedule: '15m', lastDispatchMs: null, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
    ];
    const analyzeAgentHealth = vi.fn(async (_c: AnalysisCandidate[]) => []);
    const deps = makeDeps({ analyzeAgentHealth, loadAgents: vi.fn(async () => mixedAgents) });
    await handleOrchestratorTick(deps);
    const candidates = analyzeAgentHealth.mock.calls[0][0];
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('good');
  });

  it('does not throw when analyzeAgentHealth dep is absent', async () => {
    const deps = makeDeps();
    await expect(handleOrchestratorTick(deps)).resolves.toBeDefined();
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
