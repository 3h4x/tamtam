// graphile-worker task: orchestrator-tick
//
// Fires every 5 minutes (self-reenqueue). Reads the stats/bridge snapshot,
// asks `decideBoosts` for projects that deserve an extra agent fire given
// current pace headroom, and enqueues those bonus fires via the existing
// `agent-cron` task. Settings-gated end-to-end — when
// `orchestrator_enabled=false`, the tick still re-enqueues itself so the
// chain doesn't die, but it skips decision + dispatch.

import type { JobHelpers, Task } from 'graphile-worker';
import {
  decideBoosts,
  pruneBoostHistory,
  recordBoosts,
  type BoostDecision,
  type BoostHistoryInput,
  type BoostAgentInput,
} from '@/lib/orchestrator/budget-allocator';

export const ORCHESTRATOR_TICK_INTERVAL_MS = 2 * 60 * 1000;
export const ORCHESTRATOR_TICK_JOB_KEY = 'orchestrator-tick';

export interface OrchestratorTickDeps {
  /** Read the user's master switch + tuning. Returns null when the
   *  orchestrator is disabled — task body short-circuits. */
  loadConfig: () => Promise<null | {
    marginPct: number;
    maxBoostsPerHour: number;
  }>;
  /** Returns the same shape `/api/stats/bridge` serves. We don't HTTP-call
   *  it because the workflow runtime + graphile share this Next.js process;
   *  the function-call route avoids the extra round-trip and the JSON parse.
   *  The caller in instrumentation-node.ts wires this to a direct call. */
  loadBridge: () => Promise<{
    globalPace: {
      status: 'under_pace' | 'on_pace' | 'over_pace' | 'paused' | 'unknown';
      marginPct: number;
    };
    projects: Array<{
      project: string;
      status: string;
      paused: boolean;
      releaseRunning: boolean;
      lastPushAt: number | null;
    }>;
  }>;
  /** Returns every enabled, scheduled agent across the workspace. Used to
   *  rank "which agent should we boost first" inside each project. */
  loadAgents: () => Promise<BoostAgentInput[]>;
  /** Enqueue an immediate fire for one agent. The wrapper around
   *  `quickAddJob('agent-cron', ..., { runAt: now })`. */
  enqueueAgentFire: (agentId: string, runAt: Date) => Promise<void>;
  /** Self-reenqueue (with key collision = replace). Mirrors the
   *  project-sweep pattern so a restart doesn't kill the chain. */
  enqueueNextFire: (runAt: Date) => Promise<void>;
  now?: () => number;
}

export interface OrchestratorTickResult {
  enabled: boolean;
  decisions: BoostDecision[];
  error?: string;
  nextFireAt: Date;
}

// History lives on globalThis so the rolling rate-limit window survives the
// per-tick function call without persisting to DB. Lost on restart (intentional —
// fresh boot starts with a clean budget; better than over-charging from stale
// in-memory state).
declare global {
  var __tamtamOrchestratorHistory: BoostHistoryInput | undefined;
}

function getHistory(): BoostHistoryInput {
  if (!globalThis.__tamtamOrchestratorHistory) {
    globalThis.__tamtamOrchestratorHistory = { byProject: new Map() };
  }
  return globalThis.__tamtamOrchestratorHistory;
}

function setHistory(next: BoostHistoryInput): void {
  globalThis.__tamtamOrchestratorHistory = next;
}

export async function handleOrchestratorTick(
  deps: OrchestratorTickDeps,
): Promise<OrchestratorTickResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  let decisions: BoostDecision[] = [];
  let error: string | undefined;

  let enabled = false;
  try {
    const cfg = await deps.loadConfig();
    enabled = cfg !== null;
    if (cfg) {
      const [bridge, agents] = await Promise.all([
        deps.loadBridge(),
        deps.loadAgents(),
      ]);
      const pruned = pruneBoostHistory(getHistory(), nowMs);
      setHistory(pruned);
      decisions = decideBoosts({
        pace: bridge.globalPace,
        projects: bridge.projects,
        agents,
        history: pruned,
        settings: {
          marginPct: cfg.marginPct,
          maxBoostsPerHour: cfg.maxBoostsPerHour,
        },
        nowMs,
      });
      if (decisions.length > 0) {
        await Promise.all(
          decisions.map((d) => deps.enqueueAgentFire(d.agentId, new Date(nowMs))),
        );
        setHistory(recordBoosts(pruned, decisions, nowMs));
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const nextFireAt = new Date(nowMs + ORCHESTRATOR_TICK_INTERVAL_MS);
  await deps.enqueueNextFire(nextFireAt);
  return { enabled, decisions, error, nextFireAt };
}

export function createOrchestratorTickTask(deps: OrchestratorTickDeps): Task {
  return async (_payload, helpers: JobHelpers) => {
    const r = await handleOrchestratorTick(deps);
    if (r.error) {
      helpers.logger.error(`orchestrator-tick: ${r.error}; next fire ${r.nextFireAt.toISOString()}`);
    } else if (!r.enabled) {
      helpers.logger.info(`orchestrator-tick: disabled, next fire ${r.nextFireAt.toISOString()}`);
    } else if (r.decisions.length === 0) {
      helpers.logger.info(`orchestrator-tick: no boost (pace ok or no eligible project), next fire ${r.nextFireAt.toISOString()}`);
    } else {
      const summary = r.decisions
        .map((d) => `${d.project}.${d.agentName}`)
        .join(', ');
      helpers.logger.info(`orchestrator-tick: boosted ${r.decisions.length} (${summary}), next fire ${r.nextFireAt.toISOString()}`);
    }
  };
}
