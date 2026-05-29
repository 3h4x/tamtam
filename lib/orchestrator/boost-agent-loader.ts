import type { FruitfulnessStats } from '@/lib/agents/fruitfulness';
import type { BoostAgentInput } from '@/lib/orchestrator/budget-allocator';
import type { AgentInput } from '@/lib/scheduling/agent-types';

interface LoadBoostAgentsDeps {
  listAgents: () => Promise<AgentInput[]>;
  getDispatches: () => Map<string, number>;
  loadFruitfulness: () => Promise<Map<string, FruitfulnessStats>>;
  onFruitfulnessError?: (err: unknown) => void;
}

export async function loadBoostAgents(deps: LoadBoostAgentsDeps): Promise<BoostAgentInput[]> {
  const fruitfulnessPromise = deps.loadFruitfulness().catch((err) => {
    deps.onFruitfulnessError?.(err);
    return new Map<string, FruitfulnessStats>();
  });
  const [all, dispatches, fruitMap] = await Promise.all([
    deps.listAgents(),
    Promise.resolve(deps.getDispatches()),
    fruitfulnessPromise,
  ]);

  return all.map((a) => {
    const stats = fruitMap.get(a.id);
    return {
      id: a.id,
      name: a.name,
      project: a.project,
      enabled: a.enabled,
      schedule: a.schedule ?? null,
      lastDispatchMs: dispatches.get(a.id) ?? null,
      kind: a.kind,
      boostable: a.boostable,
      // Omit fruitfulness when we have no signal: absence means "no penalty".
      ...(stats && stats.runs > 0
        ? { fruitfulness: { rate: stats.rate, runs: stats.runs } }
        : {}),
    };
  });
}
