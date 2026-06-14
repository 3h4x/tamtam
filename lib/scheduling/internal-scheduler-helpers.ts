// Shared agent-loading helper for the graphile-cron path. It reuses the same
// DB + .tamtam/agents/*.md scanning logic as the agents API.
//
// This helper stays because graphile cron still needs a way to enumerate
// enabled scheduled agents at boot.

import { db, schema } from '@/lib/db';
import { listEnabledProjects, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';
import { warmFileAgentOverrideCache, getFileAgentOverrideSync } from '@/lib/agents/file-agent-overrides';
import { parseAgentRole } from '@/lib/agents/roles';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { parseAutopilotState } from '@/lib/orchestrator/agent-autopilot';
import type { AgentInput } from '@/lib/scheduling/agent-types';

export async function listEnabledScheduledAgents(): Promise<AgentInput[]> {
  // The cron-task handler in graphile-worker is the first caller of this in
  // its own module realm, so the projects + file-agent-override caches are
  // both cold on the first fire. `listEnabledProjects()` and the
  // `getFileAgentOverrideSync` path inside `scanFileAgents` both fall back
  // to empty on a cache miss while spawning a fire-and-forget refresh —
  // which would make file agents invisible to seedAgentCrons / loadAgent
  // on first contact, killing the cron chain. Prime both caches
  // synchronously here so file-agent scanning always sees current state.
  await Promise.all([refreshProjectsCacheSync(), warmFileAgentOverrideCache()]);
  const allAgents = await db.select().from(schema.agents);
  // Single-pass filter+map+key-set build instead of three iterations over the
  // same rows (filter, map, then map again into a Set for the dedup key set).
  const dbEnabled: AgentInput[] = [];
  const dbAgentKeys = new Set<string>();
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
    dbAgentKeys.add(`${a.project}:${a.name}`);
  }

  // File agents (`.tamtam/agents/*.md`) — DB agents with the same project+name
  // take precedence (matches `app/api/agents/route.ts` GET semantics).
  const fileEnabled: AgentInput[] = [];
  try {
    const { scanFileAgents } = await import('@/lib/agents/tamtam-file-agents');
    for (const p of listEnabledProjects()) {
      try {
        const fileAgents = scanFileAgents(p.path, p.name);
        for (const fa of fileAgents) {
          if (!fa.enabled || !fa.schedule) continue;
          if (dbAgentKeys.has(`${fa.project}:${fa.name}`)) continue;
          // File agents have no DB row, so their role + autopilot state live in
          // the file-agent override (settings table). buildFileAgent already
          // resolved role onto `fa`; read the autopilot blob here.
          const override = getFileAgentOverrideSync(fa.project, fa.name);
          fileEnabled.push({
            id: fa.id,
            project: fa.project,
            name: fa.name,
            schedule: fa.schedule,
            prompt: fa.prompt,
            enabled: fa.enabled,
            kind: 'user',
            // File-agent override file may flip this off; default true.
            boostable: (fa as { boostable?: boolean }).boostable ?? true,
            model: normalizeModelInput(fa.model, 'normal'),
            role: parseAgentRole(fa.role),
            autopilot: parseAutopilotState(override?.autopilotState),
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
