// Shared agent-loading helper for the graphile-cron path. It enumerates the
// enabled scheduled agents from the DB (the single source of truth).
//
// This helper stays because graphile cron still needs a way to enumerate
// enabled scheduled agents at boot.

import { db, schema } from '@/lib/db';
import { refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';
import { parseAgentRole } from '@/lib/agents/roles';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { parseAutopilotState } from '@/lib/orchestrator/agent-autopilot';
import type { AgentInput } from '@/lib/scheduling/agent-types';

export async function listEnabledScheduledAgents(): Promise<AgentInput[]> {
  // The cron-task handler in graphile-worker is the first caller of this in
  // its own module realm, so the projects cache is cold on the first fire.
  // Prime it synchronously so downstream project lookups see current state.
  await refreshProjectsCacheSync();
  const allAgents = await db.select().from(schema.agents);
  const dbEnabled: AgentInput[] = [];
  for (const a of allAgents) {
    if (!a.enabled || !a.schedule) continue;
    dbEnabled.push({
      id: a.id,
      project: a.project,
      name: a.name,
      schedule: a.schedule,
      prompt: a.prompt ?? '',
      enabled: !!a.enabled,
      kind: (a.kind === 'system' ? 'system' : 'user') as 'user' | 'system',
      boostable: a.boostable ?? true,
      model: normalizeModelInput(a.model, 'normal'),
      role: parseAgentRole(a.role),
      autopilot: parseAutopilotState(a.autopilotState),
    });
  }
  return dbEnabled;
}
