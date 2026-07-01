// Apply autopilot decisions — the IO half of the autopilot loop. The pure
// decision lives in `agent-autopilot.ts`; this module loads the analyzed agents,
// runs the decision, persists the resulting `autopilot_state` (DB column), and
// records an `agent_autopilot` recommendation for each action so the operator
// sees what changed in History.
//
// Called fire-and-forget from the orchestrator tick after health analysis.
// Cadence/model overrides take effect on each agent's next natural fire via the
// dispatch-time resolution in `agent-cron-task.ts` — no immediate reschedule.

import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';
import { clearAgentsCache } from '@/lib/agents/agents-cache';
import { parseAgentRole } from '@/lib/agents/roles';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { upsertRecommendation } from '@/lib/recommendations/recommendations';
import { loadAllAgentFruitfulness } from '@/lib/agents/fruitfulness';
import {
  UNFRUITFUL_MIN_SAMPLE,
  UNFRUITFUL_RATE_THRESHOLD,
} from '@/lib/orchestrator/budget-allocator';
import type { HealthAnalysisOutcome } from '@/lib/orchestrator/agent-health-analysis';
import {
  decideAutopilot,
  serializeAutopilotState,
  parseAutopilotState,
  type AutopilotAgentInput,
  type AutopilotDecision,
  type AutopilotState,
} from '@/lib/orchestrator/agent-autopilot';

/** Load full autopilot data for ONLY the agents analyzed this tick (<=3),
 *  keyed by id. Deliberately avoids the workspace-wide
 *  `listEnabledScheduledAgents()` scan (full agents table) — the autopilot only
 *  ever touches the handful of agents the health pass just looked at, and that
 *  scan was already run once this tick for the boost decision. */
async function loadAnalyzedAgents(ids: string[]): Promise<AutopilotAgentInput[]> {
  const out: AutopilotAgentInput[] = [];
  if (ids.length === 0) return out;

  const rows = await db.select().from(schema.agents).where(inArray(schema.agents.id, ids));
  for (const a of rows) {
    if (!a.enabled || !a.schedule) continue;
    out.push({
      id: a.id,
      name: a.name,
      project: a.project,
      role: parseAgentRole(a.role),
      kind: a.kind === 'system' ? 'system' : 'user',
      enabled: !!a.enabled,
      schedule: a.schedule,
      model: normalizeModelInput(a.model, 'normal'),
      autopilot: parseAutopilotState(a.autopilotState),
    });
  }

  return out;
}

async function persistState(
  agent: { id: string; project: string; name: string },
  state: AutopilotState,
): Promise<void> {
  await db
    .update(schema.agents)
    .set({ autopilotState: serializeAutopilotState(state), updatedAt: Date.now() / 1000 })
    .where(eq(schema.agents.id, agent.id))
    .execute();
}

async function recordAction(decision: AutopilotDecision): Promise<void> {
  if (!decision.action) return;
  const { kind, from, to, reason } = decision.action;
  const verb =
    kind === 'throttle'
      ? 'Throttled'
      : kind === 'restore-cadence'
        ? 'Restored cadence for'
        : kind === 'downgrade'
          ? 'Downgraded model for'
          : 'Restored model for';
  await upsertRecommendation({
    project: decision.project,
    sourceKind: 'orchestrator',
    sourceId: null,
    agentId: decision.agentId,
    agentName: decision.agentName,
    type: 'agent_autopilot',
    title: `${verb} ${decision.agentName} (${from} → ${to})`,
    detail: reason,
    // Done-on-arrival AUTO note — the lever already moved. Archive straight to
    // History like orchestrator_boost.
    status: 'resolved',
    payload: { action: kind, role: decision.role, from, to, reason },
  });
}

/** Run + apply the autopilot for the agents analyzed this tick. Returns the
 *  decisions that produced an action (for logging). Errors are swallowed per
 *  agent so one bad apply never blocks the tick. */
export async function applyAutopilot(
  outcomes: HealthAnalysisOutcome[],
): Promise<AutopilotDecision[]> {
  const settings = getSettings();
  if (!settings.agent_autopilot_enabled) return [];
  if (outcomes.length === 0) return [];

  const agents = await loadAnalyzedAgents(outcomes.map((o) => o.agentId));

  // Attach the same per-agent fruitfulness signal the boost allocator uses, so a
  // persistently unproductive producer is cadence-throttled even when the LLM
  // never raises a loop/noise verdict. Best-effort: on a load failure the
  // autopilot just falls back to the verdict-only behavior.
  let fruitfulness = new Map<string, { rate: number; runs: number }>();
  try {
    const stats = await loadAllAgentFruitfulness({});
    for (const [id, s] of stats) fruitfulness.set(id, { rate: s.rate, runs: s.runs });
  } catch (err) {
    console.warn('[autopilot] fruitfulness load failed; verdict-only this tick:', err);
  }
  const agentsWithFruitfulness = agents.map((a) => ({
    ...a,
    fruitfulness: fruitfulness.get(a.id) ?? null,
  }));

  const decisions = decideAutopilot({
    agents: agentsWithFruitfulness,
    outcomes,
    settings: {
      cadenceFloor: settings.agent_autopilot_cadence_floor,
      tierFloor: settings.agent_autopilot_tier_floor,
      idleStreak: settings.agent_autopilot_idle_streak,
      concernStreak: settings.agent_autopilot_concern_streak,
      unfruitfulRate: UNFRUITFUL_RATE_THRESHOLD,
      unfruitfulMinSample: UNFRUITFUL_MIN_SAMPLE,
    },
  });

  const acted: AutopilotDecision[] = [];
  let touched = false;
  for (const decision of decisions) {
    const agent = agents.find((a) => a.id === decision.agentId);
    if (!agent) continue;
    try {
      // Skip the write when the decision left state unchanged — the common
      // steady-state case (a healthy producer, or a drift/quality concern we
      // don't act on). Persisting an identical state would churn the agent
      // row's updatedAt and blow away the agents cache every tick for nothing.
      if (serializeAutopilotState(agent.autopilot) !== serializeAutopilotState(decision.persistState)) {
        await persistState(agent, decision.persistState);
        touched = true;
      }
      if (decision.action) {
        await recordAction(decision);
        acted.push(decision);
      }
    } catch (err) {
      console.warn(`[autopilot] apply failed for ${decision.agentId}:`, err);
    }
  }
  if (touched) clearAgentsCache();
  return acted;
}
