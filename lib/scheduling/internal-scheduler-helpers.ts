// Shared agent-loading helper. Extracted from `reinstallAgents()` in
// instrumentation-node.ts so the new graphile-cron path
// (lib/workflows/cron/seed-agent-crons.ts) and the legacy in-memory
// scheduler can use the same DB + .tamtam/agents/*.md scanning logic.
//
// When the in-memory scheduler is removed, this helper stays — the
// graphile cron still needs a way to enumerate enabled scheduled
// agents at boot.

import { db, schema } from '@/lib/db';
import { listEnabledProjects, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';
import { warmFileAgentOverrideCache } from '@/lib/agents/file-agent-overrides';
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
  const dbEnabled: AgentInput[] = allAgents
    .filter((a) => a.enabled && a.schedule)
    .map((a) => ({
      id: a.id,
      project: a.project,
      name: a.name,
      schedule: a.schedule,
      prompt: a.prompt ?? '',
      enabled: !!a.enabled,
      kind: (a.kind === 'system' ? 'system' : 'user') as 'user' | 'system',
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
            kind: 'user',
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
