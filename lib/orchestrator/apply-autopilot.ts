// Apply autopilot decisions — the IO half of the autopilot loop. The pure
// decision lives in `agent-autopilot.ts`; this module loads the analyzed agents,
// runs the decision, persists the resulting `autopilot_state` (DB column for DB
// agents, file-agent override for file agents), and records an `agent_autopilot`
// recommendation for each action so the operator sees what changed in History.
//
// Called fire-and-forget from the orchestrator tick after health analysis.
// Cadence/model overrides take effect on each agent's next natural fire via the
// dispatch-time resolution in `agent-cron-task.ts` — no immediate reschedule.

import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';
import { clearAgentsCache } from '@/lib/agents/agents-cache';
import { setFileAgentOverride, getFileAgentOverrideSync } from '@/lib/agents/file-agent-overrides';
import { parseFileAgentId, loadFileAgent } from '@/lib/agents/tamtam-file-agents';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { parseAgentRole } from '@/lib/agents/roles';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { upsertRecommendation } from '@/lib/recommendations/recommendations';
import type { HealthAnalysisOutcome } from '@/lib/orchestrator/agent-health-analysis';
import {
  decideAutopilot,
  serializeAutopilotState,
  parseAutopilotState,
  type AutopilotAgentInput,
  type AutopilotDecision,
  type AutopilotState,
} from '@/lib/orchestrator/agent-autopilot';

function isFileAgent(id: string): boolean {
  return id.startsWith('file:');
}

/** Load full autopilot data for ONLY the agents analyzed this tick (<=3),
 *  keyed by id. Deliberately avoids the workspace-wide
 *  `listEnabledScheduledAgents()` scan (full agents table + a filesystem/git
 *  scan of every project) — the autopilot only ever touches the handful of
 *  agents the health pass just looked at, and that scan was already run once
 *  this tick for the boost decision. */
async function loadAnalyzedAgents(ids: string[]): Promise<AutopilotAgentInput[]> {
  const out: AutopilotAgentInput[] = [];
  const dbIds = ids.filter((id) => !isFileAgent(id));
  const fileIds = ids.filter(isFileAgent);

  if (dbIds.length > 0) {
    const rows = await db.select().from(schema.agents).where(inArray(schema.agents.id, dbIds));
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
  }

  for (const id of fileIds) {
    const parsed = parseFileAgentId(id);
    if (!parsed) continue;
    const projPath = resolveProjectPath(parsed.project);
    if (!projPath) continue;
    const fa = loadFileAgent(projPath, parsed.project, parsed.name);
    if (!fa || !fa.enabled || !fa.schedule) continue;
    const override = getFileAgentOverrideSync(parsed.project, parsed.name);
    out.push({
      id: fa.id,
      name: fa.name,
      project: fa.project,
      role: parseAgentRole(fa.role),
      kind: 'user',
      enabled: fa.enabled,
      schedule: fa.schedule,
      model: normalizeModelInput(fa.model, 'normal'),
      autopilot: parseAutopilotState(override?.autopilotState),
    });
  }

  return out;
}

async function persistState(
  agent: { id: string; project: string; name: string },
  state: AutopilotState,
): Promise<void> {
  if (isFileAgent(agent.id)) {
    // File agents have no DB row — their autopilot state rides in the override.
    await setFileAgentOverride(agent.project, agent.name, { autopilotState: state });
    return;
  }
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

  const decisions = decideAutopilot({
    agents,
    outcomes,
    settings: {
      cadenceFloor: settings.agent_autopilot_cadence_floor,
      tierFloor: settings.agent_autopilot_tier_floor,
      idleStreak: settings.agent_autopilot_idle_streak,
      concernStreak: settings.agent_autopilot_concern_streak,
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
