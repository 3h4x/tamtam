// graphile-worker task: orchestrator-tick
//
// Fires every 60 seconds (self-reenqueue). Reads the stats/bridge snapshot,
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
import type { HealthAnalysisOutcome } from '@/lib/orchestrator/agent-health-analysis';

export const ORCHESTRATOR_TICK_INTERVAL_MS = 60 * 1000;
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
      /** Per-provider per-window pace breakdown. Used to extract the 7-day
       *  weekly margin so the orchestrator keeps boosting past short-window
       *  catch-up until the weekly deficit closes. */
      providers?: Array<{
        provider: string;
        sevenDay?: { paceMarginPct?: number; status?: string } | null;
      }>;
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
  enqueueAgentFire: (
    agentId: string,
    runAt: Date,
    modelOverride?: 'fast' | 'normal' | 'smart',
  ) => Promise<void>;
  /** Self-reenqueue (with key collision = replace). Mirrors the
   *  project-sweep pattern so a restart doesn't kill the chain. */
  enqueueNextFire: (runAt: Date) => Promise<void>;
  now?: () => number;
  /** Optional — when present, persists each boost decision as an
   *  orchestrator_boost recommendation so the /recommendations page can show
   *  what the orchestrator did automatically. Fire-and-forget; errors are
   *  swallowed so a recommendation write failure never blocks the tick. */
  recordBoostRecommendations?: (decisions: BoostDecision[]) => Promise<void>;
  /** Optional — when present, runs an LLM-based health analysis on a small
   *  set of eligible agents per tick (those with new runs since their last
   *  completed analysis). Gated on safe pace and tracked on globalThis.
   *  Fire-and-forget; errors are swallowed. */
  analyzeAgentHealth?: (candidates: AnalysisCandidate[]) => Promise<HealthAnalysisOutcome[]>;
  /** Optional — returns the newest finished scheduled run for an agent. Used
   *  to avoid re-analyzing old finished samples while a newer dispatch is
   *  still queued or running. */
  loadLatestFinishedRunStartedAt?: (candidate: AnalysisCandidate) => Promise<number | null>;
  /** Optional — returns pending in-memory queue depth per project. When a
   *  project has agents already waiting in the queue, a new boost would only
   *  lengthen the queue behind those waiting agents; skipping the boost lets
   *  the queue drain naturally and prevents high-frequency agents from starving
   *  lower-frequency ones. */
  getProjectQueueCounts?: () => Promise<Map<string, number>> | Map<string, number>;
}

/** Minimal agent identity passed to the health analysis phase. The analysis
 *  function loads the agent's own recent runs from the DB; the tick only needs
 *  to tell it *which* agents to look at. */
export interface AnalysisCandidate {
  id: string;
  name: string;
  project: string;
}

interface HealthAnalysisMarker {
  analyzedAtMs: number;
  latestRunStartedAt: number;
}

export interface OrchestratorTickResult {
  enabled: boolean;
  decisions: BoostDecision[];
  error?: string;
  nextFireAt: Date;
}

// Pace statuses where it's safe to spend tokens on health analysis. Anything
// else (will_exceed, exceeded, unknown, paused) skips the LLM phase so the
// orchestrator never burns budget diagnosing agents while over plan.
const HEALTH_ANALYSIS_SAFE_PACE = new Set(['under_pace', 'on_pace']);
// Cap LLM calls per tick so a large fleet can't fan out dozens of Haiku
// requests in a single 60s tick.
const HEALTH_ANALYSIS_MAX_PER_TICK = 3;

// History lives on globalThis so the rolling rate-limit window survives the
// per-tick function call without persisting to DB. Lost on restart (intentional —
// fresh boot starts with a clean budget; better than over-charging from stale
// in-memory state).
declare global {
  var __tamtamOrchestratorHistory: BoostHistoryInput | undefined;
  // agentId -> latest scheduled run covered by a completed health analysis.
  // In-memory only (lost on restart, which just gives every agent a fresh
  // analysis pass — safe).
  var __tamtamAgentHealthAnalyzed: Map<string, HealthAnalysisMarker | number> | undefined;
  // agentIds currently being analyzed. Suppresses duplicate LLM calls when a
  // tick fires again before the previous fire-and-forget analysis settles.
  var __tamtamAgentHealthInFlight: Set<string> | undefined;
}

function getHealthAnalyzedMap(): Map<string, HealthAnalysisMarker | number> {
  if (!globalThis.__tamtamAgentHealthAnalyzed) {
    globalThis.__tamtamAgentHealthAnalyzed = new Map();
  }
  return globalThis.__tamtamAgentHealthAnalyzed;
}

function healthMarker(value: HealthAnalysisMarker | number | undefined): HealthAnalysisMarker | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    return { analyzedAtMs: value, latestRunStartedAt: value };
  }
  return value;
}

function getHealthInFlightSet(): Set<string> {
  if (!globalThis.__tamtamAgentHealthInFlight) {
    globalThis.__tamtamAgentHealthInFlight = new Set();
  }
  return globalThis.__tamtamAgentHealthInFlight;
}

/** Pick up to N agents to analyze this tick: enabled, user-kind, scheduled,
 *  and either never analyzed or has a newer finished scheduled run than the
 *  latest run covered by a completed analysis. Dispatch time is used as a
 *  cheap prefilter before the DB freshness lookup so a large fleet does not
 *  perform one query per already-covered agent every tick. Oldest-analyzed
 *  first so every agent eventually gets a turn instead of the same few being
 *  re-picked. */
async function selectHealthCandidates(
  agents: BoostAgentInput[],
  loadLatestFinishedRunStartedAt?: (candidate: AnalysisCandidate) => Promise<number | null>,
): Promise<AnalysisCandidate[]> {
  const analyzed = getHealthAnalyzedMap();
  const inFlight = getHealthInFlightSet();
  const possible: Array<{
    candidate: AnalysisCandidate;
    analyzedAtMs: number;
    marker?: HealthAnalysisMarker;
  }> = [];

  for (const agent of agents) {
    if (agent.kind !== 'user' || !agent.enabled || !agent.schedule) continue;
    if (inFlight.has(agent.id)) continue;

    const candidate = { id: agent.id, name: agent.name, project: agent.project };
    const marker = healthMarker(analyzed.get(agent.id));
    if (marker) {
      if (agent.lastDispatchMs == null || agent.lastDispatchMs <= marker.latestRunStartedAt) continue;
      possible.push({ candidate, analyzedAtMs: marker.analyzedAtMs, marker });
      continue;
    }

    possible.push({ candidate, analyzedAtMs: 0 });
  }

  const selected = possible
    .sort((a, b) => {
      return a.analyzedAtMs - b.analyzedAtMs;
    })
    .slice(0, HEALTH_ANALYSIS_MAX_PER_TICK);

  const candidates: AnalysisCandidate[] = [];
  for (const item of selected) {
    if (!item.marker) {
      candidates.push(item.candidate);
      continue;
    }
    if (!loadLatestFinishedRunStartedAt) continue;
    const latestFinished = await loadLatestFinishedRunStartedAt(item.candidate);
    if (latestFinished == null || latestFinished <= item.marker.latestRunStartedAt) continue;
    candidates.push(item.candidate);
  }
  return candidates;
}

function recordHealthAnalysisOutcomes(outcomes: HealthAnalysisOutcome[], analyzedAtMs: number): void {
  const analyzed = getHealthAnalyzedMap();
  for (const outcome of outcomes) {
    if (!outcome.analyzed || outcome.latestRunStartedAt == null) continue;
    analyzed.set(outcome.agentId, {
      analyzedAtMs,
      latestRunStartedAt: outcome.latestRunStartedAt,
    });
  }
}

function markHealthAnalysisInFlight(candidates: AnalysisCandidate[]): void {
  const inFlight = getHealthInFlightSet();
  for (const candidate of candidates) {
    inFlight.add(candidate.id);
  }
}

function clearHealthAnalysisInFlight(candidates: AnalysisCandidate[]): void {
  const inFlight = getHealthInFlightSet();
  for (const candidate of candidates) {
    inFlight.delete(candidate.id);
  }
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
      // Pull the largest weekly (7d) margin across providers — the binding
      // globalPace only reflects the tightest window, so a 5h "on_pace" hides
      // an underspent week. We must catch up before the weekly reset, so
      // expose this to the allocator as a separate boost gate.
      const weeklyMarginPct = (bridge.globalPace.providers ?? []).reduce<number>((max, p) => {
        const m = p.sevenDay?.paceMarginPct;
        if (typeof m !== 'number' || !isFinite(m)) return max;
        if (p.sevenDay?.status === 'unknown') return max;
        return m > max ? m : max;
      }, -Infinity);
      decisions = decideBoosts({
        pace: {
          status: bridge.globalPace.status,
          marginPct: bridge.globalPace.marginPct,
          weeklyMarginPct: isFinite(weeklyMarginPct) ? weeklyMarginPct : undefined,
        },
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
        // Skip boost decisions for projects that already have agents waiting in
        // the in-memory pending queue. Those queued agents will drain naturally
        // when the current run finishes — boosting again only lengthens the
        // queue further and lets a high-frequency agent starve waiting ones.
        const queueCounts = deps.getProjectQueueCounts
          ? await Promise.resolve(deps.getProjectQueueCounts())
          : new Map<string, number>();
        const toFire = decisions.filter((d) => (queueCounts.get(d.project) ?? 0) === 0);
        if (toFire.length > 0) {
          await Promise.all(
            toFire.map((d) => deps.enqueueAgentFire(d.agentId, new Date(nowMs), d.modelOverride)),
          );
          setHistory(recordBoosts(pruned, toFire, nowMs));
          if (deps.recordBoostRecommendations) {
            deps.recordBoostRecommendations(toFire).catch(() => {});
          }
          decisions = toFire;
        } else {
          decisions = [];
        }
      }

      // Health analysis phase — gated on safe pace so we never spend tokens
      // diagnosing agents while over budget. Fire-and-forget so a slow Haiku
      // call can't delay the next tick.
      if (deps.analyzeAgentHealth && HEALTH_ANALYSIS_SAFE_PACE.has(bridge.globalPace.status as string)) {
        const candidates = await selectHealthCandidates(agents, deps.loadLatestFinishedRunStartedAt);
        if (candidates.length > 0) {
          markHealthAnalysisInFlight(candidates);
          deps.analyzeAgentHealth(candidates)
            .then((outcomes) => recordHealthAnalysisOutcomes(outcomes, nowMs))
            .catch(() => {})
            .finally(() => clearHealthAnalysisInFlight(candidates));
        }
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
