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
  /** Bridge's `globalPace.status` on the *binding* (tightest) window. */
  status: 'under_pace' | 'on_pace' | 'over_pace' | 'paused' | 'unknown';
  /** Bridge's `globalPace.marginPct`: how many percentage points the binding
   *  provider has between elapsed-time and projected utilization. Higher
   *  margin = more headroom = safer to boost. */
  marginPct: number;
  /** Max `paceMarginPct` across every enabled provider's 7-day window.
   *  Positive means we're behind on weekly burn even if the short (5h) window
   *  has caught up. The orchestrator must over-shoot the short-window pace to
   *  recover this deficit before the weekly reset, so boosts continue while
   *  this is above the configured floor — even when `status` is `'on_pace'`. */
  weeklyMarginPct?: number;
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
  /** Unix ms of the most recent real dispatch. Queued/skipped attempts must
   *  not update this value, otherwise pending rows can starve an agent out of
   *  boost eligibility without it actually running. */
  lastDispatchMs: number | null;
  /** `'system'` agents run internal handlers (e.g. retrieval reindex) that
   *  don't consume codex/claude budget — boosting them can't catch up pace.
   *  `'user'` agents go through the CLI and are the real boost candidates. */
  kind: 'user' | 'system';
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
  /** When set, the orchestrator-boosted fire uses this model tier instead of
   *  the agent's configured default. The allocator promotes one tier
   *  (fast→normal, normal→smart, smart→smart) when the weekly deficit is too
   *  large to close via extra runs alone — bigger models burn more tokens
   *  per call, multiplying the per-run impact of each boost. */
  modelOverride?: 'fast' | 'normal' | 'smart';
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
// Keep a real dispatch cool for a full orchestrator interval. Otherwise a
// boosted agent can be selected again while its previous graphile fire is
// still being processed, replacing the next-fire row with `runAt: now()`.
const AGENT_RECENT_DISPATCH_COOLDOWN_MS = 5 * 60 * 1000;

// Default boost set covers every project we *want* to be shipping. Idle and
// attention projects are the obvious headroom — if pace is under, we'd rather
// wake a dormant project than do nothing. Releasing / agent_running / stuck /
// error / paused stay excluded (already burning, or operator should look).
const BOOSTABLE_PROJECT_STATUSES = new Set(['shipping', 'active', 'idle', 'attention']);
// When pace is *severely* under the floor, lean in harder: also fire on
// `agent_running` so the per-project queue stacks up the next run, and tighten
// the threshold so we trip the multi-pick branch with less slack.
const SEVERELY_UNDER_PACE_PP = 10;
const SEVERELY_UNDER_STATUSES = new Set([
  'shipping',
  'active',
  'idle',
  'attention',
  'agent_running',
]);
// Slack threshold (effective margin - floor) above which boosted runs get a
// model tier promotion to `smart`. At this much weekly headroom, scheduling
// more runs alone won't close the gap — each run also needs to burn more
// tokens, which a stronger model accomplishes by reasoning longer and
// emitting larger outputs. Kept low (~10pp) so promotion stays active as
// the margin closes; turning it off only when we're nearly on pace.
const AGGRESSIVE_CATCHUP_PP = 10;

export function decideBoosts(input: BoostInput): BoostDecision[] {
  const now = input.nowMs ?? Date.now();

  if (input.settings.maxBoostsPerHour <= 0) return [];
  // Effective margin = whichever window has more headroom. The short window
  // catches up first; the 7-day weekly window lags. We must keep firing while
  // EITHER signal shows headroom above the floor, so the weekly deficit
  // actually closes instead of staying behind forever.
  const weeklyMargin = input.pace.weeklyMarginPct ?? 0;
  const shortMargin = input.pace.status === 'under_pace' ? input.pace.marginPct : -Infinity;
  const effectiveMargin = Math.max(shortMargin, weeklyMargin);
  if (effectiveMargin < input.settings.marginPct) return [];

  const agentsByProject = new Map<string, BoostAgentInput[]>();
  for (const agent of input.agents) {
    if (!agent.enabled) continue;
    if (!agent.schedule || agent.schedule.trim() === '') continue;
    // System agents run internal handlers (reindex etc.), not CLI providers,
    // so boosting them doesn't burn the budget the orchestrator is trying to
    // catch up on. Skip them entirely.
    if (agent.kind === 'system') continue;
    const arr = agentsByProject.get(agent.project) ?? [];
    arr.push(agent);
    agentsByProject.set(agent.project, arr);
  }

  const decisions: BoostDecision[] = [];
  const slackPp = effectiveMargin - input.settings.marginPct;
  const severelyUnderPace = slackPp >= SEVERELY_UNDER_PACE_PP;
  const aggressiveCatchup = slackPp >= AGGRESSIVE_CATCHUP_PP;
  const allowedStatuses = severelyUnderPace ? SEVERELY_UNDER_STATUSES : BOOSTABLE_PROJECT_STATUSES;
  for (const project of input.projects) {
    if (project.paused) continue;
    // releaseRunning USED to exclude — removed so agents can run in parallel
    // with active releases (per-project agent serialization still applies via
    // pending-agent-run, which queues or 409s as appropriate).
    if (!allowedStatuses.has(project.status)) continue;

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

    // When pace is severely under (margin far above the configured floor),
    // boost more than one agent per project so the catch-up rate actually
    // moves. `picksThisTick` grows with the headroom: 1 agent at the
    // threshold, +1 per additional 10pp of margin, capped at 5 picks per
    // project per tick (and bounded by the rate-limit budget below).
    const slack = Math.max(0, effectiveMargin - input.settings.marginPct);
    const desiredPicks = Math.min(5, 1 + Math.floor(slack / 10));
    const budgetLeft = Math.max(0, input.settings.maxBoostsPerHour - recent.length);
    const picksThisTick = Math.min(desiredPicks, budgetLeft, ranked.length);
    for (let i = 0; i < picksThisTick; i++) {
      const pick = ranked[i];
      decisions.push({
        project: project.project,
        agentId: pick.id,
        agentName: pick.name,
        reason: `pace headroom ${effectiveMargin}pp (short=${input.pace.marginPct}, weekly=${weeklyMargin}); ${project.status} project; pick ${i + 1}/${picksThisTick}${aggressiveCatchup ? '; model→smart' : ''}`,
        ...(aggressiveCatchup ? { modelOverride: 'smart' as const } : {}),
      });
    }
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
