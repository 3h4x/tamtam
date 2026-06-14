// Agent autopilot — the pure decision that turns the orchestrator's per-agent
// health signal into a bounded, reversible budget-saving action, interpreted by
// the agent's role.
//
// Three policies (see lib/agents/roles.ts):
//   producer            -> cadence-throttle one ladder rung on a SUSTAINED
//                          loop/noise verdict; restore on recovery (clean
//                          verdict or a fruitful run). Never disabled.
//   monitor/reviewer/planner -> model-downgrade one tier after a SUSTAINED
//                          all-clear streak; restore the tier the moment the
//                          agent finds something. Cadence is never touched
//                          (that would kill freshness — the audit-logs problem).
//   publisher / system  -> untouched.
//
// Driven off `HealthAnalysisOutcome[]` (the agents analyzed this tick), so it is
// naturally rate-limited by the health-analysis cap (<=3 agents/tick, ~30-min
// per-agent cooldown). Pure and stateless — the orchestrator tick feeds it real
// data and persists `persistState` / writes the recommendation. Mirrors
// `budget-allocator.ts` so the policy is unit-testable without a worker or DB.

import type { ModelTier } from '@/lib/agents/model-aliases';
import type { HealthAnalysisOutcome } from '@/lib/orchestrator/agent-health-analysis';
import {
  type AgentRole,
  isCadenceThrottleable,
  isModelDowngradeable,
  isAutopilotExempt,
} from '@/lib/agents/roles';
import { nextSlowerSchedule, nextCheaperTier } from '@/lib/scheduling/schedule-ladder';

/** Runtime autopilot overrides + streak counters, persisted as JSON in
 *  `agents.autopilot_state`. Kept separate from the operator-configured
 *  `model`/`schedule` so those stay pristine and restore is a field-clear. */
export interface AutopilotState {
  /** Active cadence override (producer throttle). When set, dispatch uses this
   *  instead of the agent's configured `schedule`. */
  scheduleOverride?: string;
  /** Active model-tier override (monitor/reviewer/planner downgrade). */
  modelOverride?: ModelTier;
  /** Consecutive loop/noise analyses since the last producer throttle step. */
  concernStreak?: number;
  /** Consecutive all-clear analyses since the last monitor downgrade step. */
  idleStreak?: number;
  /** The configured cadence captured at first throttle, for restore. */
  originalSchedule?: string;
  /** The configured tier captured at first downgrade, for restore. */
  originalModel?: ModelTier;
  /** Unix ms of the last applied autopilot action. */
  lastActionAt?: number;
}

export interface AutopilotAgentInput {
  id: string;
  name: string;
  project: string;
  role: AgentRole;
  kind: 'user' | 'system';
  enabled: boolean;
  /** Operator-configured base cadence (may be a plain interval or cron). */
  schedule: string | null;
  /** Operator-configured base model tier. */
  model: ModelTier;
  /** Parsed current autopilot state ({} when none). */
  autopilot: AutopilotState;
}

export interface AutopilotSettings {
  /** Producers are never throttled past this cadence. */
  cadenceFloor: string;
  /** Downgrades never go below this tier. */
  tierFloor: ModelTier;
  /** All-clear analyses required before a monitor model-downgrade step. */
  idleStreak: number;
  /** Sustained loop/noise analyses required before a producer throttle step. */
  concernStreak: number;
}

export interface AutopilotInput {
  /** Every enabled scheduled agent, keyed for lookup by outcome agentId. */
  agents: AutopilotAgentInput[];
  /** Health outcomes from this tick's analysis — the drive list. */
  outcomes: HealthAnalysisOutcome[];
  settings: AutopilotSettings;
  nowMs?: number;
}

/** Parse a stored autopilot_state JSON blob (DB column or file-agent override)
 *  into a state object. Returns {} for null/empty/malformed input. */
export function parseAutopilotState(raw: unknown): AutopilotState {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as AutopilotState;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AutopilotState) : {};
  } catch {
    return {};
  }
}

/** Serialize state for persistence — returns null when the state is empty so we
 *  store NULL rather than `{}`. */
export function serializeAutopilotState(state: AutopilotState): string | null {
  const keys = Object.keys(state) as (keyof AutopilotState)[];
  const hasValue = keys.some((k) => state[k] !== undefined);
  return hasValue ? JSON.stringify(state) : null;
}

export type AutopilotActionKind = 'throttle' | 'restore-cadence' | 'downgrade' | 'upgrade';

export interface AutopilotDecision {
  agentId: string;
  agentName: string;
  project: string;
  role: AgentRole;
  /** Always persist this to `agents.autopilot_state` (streak bumps included). */
  persistState: AutopilotState;
  /** Present only when a real lever changed — the caller writes an
   *  `agent_autopilot` recommendation and re-syncs the schedule. */
  action?: {
    kind: AutopilotActionKind;
    from: string;
    to: string;
    reason: string;
  };
}

// Producer cadence-throttle triggers only on these LLM verdicts. drift/quality
// are deliberately excluded — they usually warrant a prompt fix, not a slower
// cadence, so they stay operator-owned.
const THROTTLE_CONCERN_TYPES = new Set(['loop', 'noise']);

function decideProducer(
  agent: AutopilotAgentInput,
  outcome: HealthAnalysisOutcome,
  settings: AutopilotSettings,
  now: number,
): AutopilotDecision {
  const state = agent.autopilot;
  const base: AutopilotDecision = {
    agentId: agent.id,
    agentName: agent.name,
    project: agent.project,
    role: agent.role,
    persistState: { ...state },
  };

  const recovered = outcome.concern === false || outcome.anyFruitful === true;
  if (recovered) {
    // Reset the streak; if currently throttled, restore the configured cadence
    // in full — a producing agent earns back its cadence immediately.
    const next: AutopilotState = { ...state, concernStreak: 0 };
    if (state.scheduleOverride) {
      const from = state.scheduleOverride;
      const to = state.originalSchedule ?? agent.schedule ?? from;
      delete next.scheduleOverride;
      delete next.originalSchedule;
      next.lastActionAt = now;
      return {
        ...base,
        persistState: next,
        action: {
          kind: 'restore-cadence',
          from,
          to,
          reason: `${agent.name} produced value again — restored cadence ${from} → ${to}.`,
        },
      };
    }
    return { ...base, persistState: next };
  }

  const churning = outcome.concern === true && THROTTLE_CONCERN_TYPES.has(outcome.concernType ?? '');
  if (!churning) {
    // drift/quality concern or no signal — leave state untouched (operator-owned).
    return base;
  }

  const streak = (state.concernStreak ?? 0) + 1;
  if (streak < settings.concernStreak) {
    return { ...base, persistState: { ...state, concernStreak: streak } };
  }

  // Sustained churn — step one rung slower, bounded by the floor.
  const current = state.scheduleOverride ?? agent.schedule;
  const next = nextSlowerSchedule(current, settings.cadenceFloor);
  if (!next) {
    // Already at/over the floor (or unparseable cadence). Hold; don't reset the
    // streak so a clean verdict still recovers it.
    return { ...base, persistState: { ...state, concernStreak: streak } };
  }
  return {
    ...base,
    persistState: {
      ...state,
      scheduleOverride: next,
      originalSchedule: state.originalSchedule ?? (agent.schedule ?? undefined),
      concernStreak: 0,
      lastActionAt: now,
    },
    action: {
      kind: 'throttle',
      from: String(current ?? '?'),
      to: next,
      reason: `${agent.name} flagged ${outcome.concernType} on ${settings.concernStreak} analyses — throttled cadence ${current} → ${next}.`,
    },
  };
}

function decideDowngradeable(
  agent: AutopilotAgentInput,
  outcome: HealthAnalysisOutcome,
  settings: AutopilotSettings,
  now: number,
): AutopilotDecision {
  const state = agent.autopilot;
  const base: AutopilotDecision = {
    agentId: agent.id,
    agentName: agent.name,
    project: agent.project,
    role: agent.role,
    persistState: { ...state },
  };

  // A finding (fruitful run) or a raised concern means the agent is doing real
  // work — restore the tier and reset the idle streak immediately.
  const foundSomething = outcome.anyFruitful === true || outcome.concern === true;
  if (foundSomething) {
    const next: AutopilotState = { ...state, idleStreak: 0 };
    if (state.modelOverride) {
      const from = state.modelOverride;
      const to = state.originalModel ?? agent.model;
      delete next.modelOverride;
      delete next.originalModel;
      next.lastActionAt = now;
      return {
        ...base,
        persistState: next,
        action: {
          kind: 'upgrade',
          from,
          to,
          reason: `${agent.name} found work — restored model ${from} → ${to}.`,
        },
      };
    }
    return { ...base, persistState: next };
  }

  // All-clear pass (no finding, no concern). Accumulate the idle streak.
  const streak = (state.idleStreak ?? 0) + 1;
  if (streak < settings.idleStreak) {
    return { ...base, persistState: { ...state, idleStreak: streak } };
  }

  const current = state.modelOverride ?? agent.model;
  const next = nextCheaperTier(current, settings.tierFloor);
  if (!next) {
    return { ...base, persistState: { ...state, idleStreak: streak } };
  }
  return {
    ...base,
    persistState: {
      ...state,
      modelOverride: next,
      originalModel: state.originalModel ?? agent.model,
      idleStreak: 0,
      lastActionAt: now,
    },
    action: {
      kind: 'downgrade',
      from: current,
      to: next,
      reason: `${agent.name} ran all-clear on ${settings.idleStreak} analyses — downgraded model ${current} → ${next} (cadence unchanged).`,
    },
  };
}

/** Decide autopilot actions for the agents analyzed this tick. Pure: returns
 *  one decision per analyzed, eligible agent. `persistState` is always written;
 *  `action` (when present) means a lever changed and a recommendation/ schedule
 *  re-sync is due. */
export function decideAutopilot(input: AutopilotInput): AutopilotDecision[] {
  const now = input.nowMs ?? Date.now();
  const byId = new Map(input.agents.map((a) => [a.id, a]));
  const decisions: AutopilotDecision[] = [];

  for (const outcome of input.outcomes) {
    if (!outcome.analyzed) continue;
    const agent = byId.get(outcome.agentId);
    if (!agent) continue;
    if (!agent.enabled) continue;
    if (agent.kind === 'system') continue;
    if (isAutopilotExempt(agent.role)) continue;

    if (isCadenceThrottleable(agent.role)) {
      decisions.push(decideProducer(agent, outcome, input.settings, now));
    } else if (isModelDowngradeable(agent.role)) {
      decisions.push(decideDowngradeable(agent, outcome, input.settings, now));
    }
  }

  return decisions;
}
