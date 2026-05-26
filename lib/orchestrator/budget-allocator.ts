// Budget allocator — TamTam's orchestrator brain.
//
// Problem: across N projects, the workspace burns far less than its plan
// (codex 7d ~13%, claude 7d ~44% in a real fleet snapshot). Lots of agents
// scheduled, lots of budget unspent, and a healthy project that's actively
// shipping gets the same cron cadence as a stuck or idle one. The user wants
// TamTam to coordinate: dorzucic do pieca — funnel spare budget toward
// projects that are demonstrably converting tokens into shipped commits.
//
// `decideBoosts` is the pure decision: given current pace + per-project
// health + agent rosters + recent boost history, return zero-or-more
// "boost" decisions to enqueue an immediate extra agent fire. The graphile
// wrapper (`orchestrator-tick-task.ts`) feeds it real data and dispatches
// each decision via `quickAddJob('agent-cron', { agentId }, { runAt: now() })`.
//
// Pure and stateless so it's easy to unit-test the policy without spinning
// up a worker, database, or HTTP fetch.

export interface BoostPaceInput {
  /** Bridge's `globalPace.status`. Only `'under_pace'` triggers boosts. */
  status: 'under_pace' | 'on_pace' | 'over_pace' | 'paused' | 'unknown';
  /** Bridge's `globalPace.marginPct`: how many percentage points the binding
   *  provider has between elapsed-time and projected utilization. Higher
   *  margin = more headroom = safer to boost. */
  marginPct: number;
}

export interface BoostProjectInput {
  project: string;
  /** Bridge `BridgeProjectStatus`. We only boost `shipping` / `active`. */
  status: string;
  paused: boolean;
  releaseRunning: boolean;
  /** Unix seconds. `null` when the project has never shipped. */
  lastPushAt: number | null;
}

export interface BoostAgentInput {
  id: string;
  name: string;
  project: string;
  enabled: boolean;
  /** Non-empty cron schedule string. We don't boost agents without a
   *  schedule — those are manual-trigger-only. */
  schedule: string | null;
  /** Unix ms of the most recent successful dispatch/queue. Used to spread
   *  boosts across the project's roster. */
  lastDispatchMs: number | null;
}

export interface BoostHistoryInput {
  /** project → unix-ms timestamps of recent boosts within the rolling
   *  rate-limit window. The caller is responsible for pruning entries older
   *  than the window before passing them in. */
  byProject: Map<string, number[]>;
}

export interface BoostSettings {
  /** Minimum `marginPct` required before any boost fires. Smaller = more
   *  aggressive, larger = more conservative. */
  marginPct: number;
  /** Cap how many boost fires we add per project inside the rolling
   *  rate-limit window. */
  maxBoostsPerHour: number;
}

export interface BoostDecision {
  project: string;
  agentId: string;
  agentName: string;
  reason: string;
}

export interface BoostInput {
  pace: BoostPaceInput;
  projects: BoostProjectInput[];
  agents: BoostAgentInput[];
  history: BoostHistoryInput;
  settings: BoostSettings;
  nowMs?: number;
}

const ROLLING_WINDOW_MS = 60 * 60 * 1000;
// Don't boost an agent that's already been dispatched in the last few
// minutes — graphile already has its next-fire row queued from the previous
// handler. Boosting too eagerly would replace that row with `runAt: now()`
// every tick, defeating the schedule and burning the agent on a hot loop.
const AGENT_RECENT_DISPATCH_COOLDOWN_MS = 5 * 60 * 1000;

const BOOSTABLE_PROJECT_STATUSES = new Set(['shipping', 'active']);

export function decideBoosts(input: BoostInput): BoostDecision[] {
  const now = input.nowMs ?? Date.now();

  if (input.pace.status !== 'under_pace') return [];
  if (input.pace.marginPct < input.settings.marginPct) return [];
  if (input.settings.maxBoostsPerHour <= 0) return [];

  const agentsByProject = new Map<string, BoostAgentInput[]>();
  for (const agent of input.agents) {
    if (!agent.enabled) continue;
    if (!agent.schedule || agent.schedule.trim() === '') continue;
    const arr = agentsByProject.get(agent.project) ?? [];
    arr.push(agent);
    agentsByProject.set(agent.project, arr);
  }

  const decisions: BoostDecision[] = [];
  for (const project of input.projects) {
    if (project.paused) continue;
    if (project.releaseRunning) continue;
    if (!BOOSTABLE_PROJECT_STATUSES.has(project.status)) continue;

    const recent = (input.history.byProject.get(project.project) ?? []).filter(
      (ts) => now - ts < ROLLING_WINDOW_MS,
    );
    if (recent.length >= input.settings.maxBoostsPerHour) continue;

    const candidates = agentsByProject.get(project.project) ?? [];
    if (candidates.length === 0) continue;

    // Spread the boost across the roster: pick the agent that hasn't run
    // recently. `lastDispatchMs === null` (never dispatched) sorts first.
    const ranked = candidates
      .filter((a) =>
        a.lastDispatchMs === null
        || now - a.lastDispatchMs > AGENT_RECENT_DISPATCH_COOLDOWN_MS,
      )
      .sort((a, b) => {
        const am = a.lastDispatchMs ?? 0;
        const bm = b.lastDispatchMs ?? 0;
        return am - bm;
      });
    if (ranked.length === 0) continue;

    const pick = ranked[0];
    decisions.push({
      project: project.project,
      agentId: pick.id,
      agentName: pick.name,
      reason: `pace under by ${input.pace.marginPct}pp; ${project.status} project`,
    });
  }

  return decisions;
}

/** Prune history entries older than the rolling window. Caller passes the
 *  result of a previous tick's `recordBoosts(...)`; this drops stale entries
 *  before the next `decideBoosts` call. Cheap O(n) per project. */
export function pruneBoostHistory(
  history: BoostHistoryInput,
  nowMs: number = Date.now(),
): BoostHistoryInput {
  const next = new Map<string, number[]>();
  for (const [project, entries] of history.byProject.entries()) {
    const kept = entries.filter((ts) => nowMs - ts < ROLLING_WINDOW_MS);
    if (kept.length > 0) next.set(project, kept);
  }
  return { byProject: next };
}

/** Append today's boost timestamps. Pure — does not mutate `history.byProject`
 *  or its inner arrays (the caller's snapshot stays intact for diffing). */
export function recordBoosts(
  history: BoostHistoryInput,
  decisions: BoostDecision[],
  nowMs: number = Date.now(),
): BoostHistoryInput {
  if (decisions.length === 0) return history;
  const next = new Map<string, number[]>();
  for (const [project, entries] of history.byProject.entries()) {
    next.set(project, entries.slice());
  }
  for (const d of decisions) {
    const arr = next.get(d.project) ?? [];
    arr.push(nowMs);
    next.set(d.project, arr);
  }
  return { byProject: next };
}
