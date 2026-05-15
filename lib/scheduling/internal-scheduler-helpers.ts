// Shared agent-loading helper. Extracted from `reinstallAgents()` in
// instrumentation-node.ts so the new graphile-cron path
// (lib/workflows/cron/seed-agent-crons.ts) and the legacy in-memory
// scheduler can use the same DB + .tamtam/agents/*.md scanning logic.
//
// When the in-memory scheduler is removed, this helper stays — the
// graphile cron still needs a way to enumerate enabled scheduled
// agents at boot.

import { db, schema } from '@/lib/db';
import { listEnabledProjects } from '@/lib/shared/enabled-projects';
import type { AgentInput } from '@/lib/scheduling/internal-scheduler';

export async function listEnabledScheduledAgents(): Promise<AgentInput[]> {
  const allAgents = await db.select().from(schema.agents);
  const dbEnabled: AgentInput[] = allAgents
    .filter((a) => a.enabled && a.schedule)
    .map((a) => ({
      id: a.id,
      project: a.project,
      name: a.name,
      schedule: a.schedule,
      prompt: a.prompt ?? '',
      enabled: !!a.enabled,
    }));

  // File agents (`.tamtam/agents/*.md`) — DB agents with the same project+name
  // take precedence (matches `app/api/agents/route.ts` GET semantics).
  const dbAgentKeys = new Set(dbEnabled.map((a) => `${a.project}:${a.name}`));
  const fileEnabled: AgentInput[] = [];
  try {
    const { scanFileAgents } = await import('@/lib/agents/tamtam-file-agents');
    for (const p of listEnabledProjects()) {
      try {
        const fileAgents = scanFileAgents(p.path, p.name);
        for (const fa of fileAgents) {
          if (!fa.enabled || !fa.schedule) continue;
          if (dbAgentKeys.has(`${fa.project}:${fa.name}`)) continue;
          fileEnabled.push({
            id: fa.id,
            project: fa.project,
            name: fa.name,
            schedule: fa.schedule,
            prompt: fa.prompt,
            enabled: fa.enabled,
          });
        }
      } catch (err) {
        console.error(`[scheduler] file-agent scan failed for ${p.name}:`, err);
      }
    }
  } catch {
    // projects table may not exist (test env)
  }
  return [...dbEnabled, ...fileEnabled];
}
