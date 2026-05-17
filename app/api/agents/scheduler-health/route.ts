import { NextResponse } from 'next/server';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSchedulerHealth, installAgentSchedule, getInternalSchedulerDump } from '@/lib/scheduling/agent-scheduler';
import { scanFileAgents } from '@/lib/agents/tamtam-file-agents';
import { listEnabledProjects } from '@/lib/shared/enabled-projects';
import { errMsg } from '@/lib/shared/types';

async function loadAgentsForCheck() {
  const rawAgents = await db.select().from(schema.agents);
  const dbAgents = rawAgents.map(a => ({
    id: a.id,
    project: a.project,
    name: a.name,
    schedule: a.schedule,
    enabled: !!a.enabled,
    prompt: a.prompt ?? '',
  }));
  const dbKeys = new Set(dbAgents.map(a => `${a.project}:${a.name}`));
  const fileAgents: typeof dbAgents = [];
  for (const p of listEnabledProjects()) {
    try {
      for (const fa of scanFileAgents(p.path, p.name)) {
        if (dbKeys.has(`${fa.project}:${fa.name}`)) continue;
        fileAgents.push({
          id: fa.id,
          project: fa.project,
          name: fa.name,
          schedule: fa.schedule,
          enabled: fa.enabled,
          prompt: fa.prompt,
        });
      }
    } catch { /* skip */ }
  }
  return [...dbAgents, ...fileAgents];
}

async function buildLastJobMap(entries: { agentId: string; project: string; name: string }[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const e of entries) {
    try {
      const rows = await db
        .select({ finishedAt: schema.jobs.finishedAt })
        .from(schema.jobs)
        .where(and(
          eq(schema.jobs.project, e.project),
          eq(schema.jobs.kind, `agent:${e.name}`),
          isNotNull(schema.jobs.finishedAt),
        ))
        .orderBy(desc(schema.jobs.finishedAt))
        .limit(1);
      const row = rows[0] ?? null;
      if (row?.finishedAt) map.set(e.agentId, row.finishedAt * 1000);
    } catch {
      // jobs table may not exist in test environments
    }
  }
  return map;
}

export async function GET() {
  try {
    const agents = await loadAgentsForCheck();
    const health = await getSchedulerHealth(agents);
    const internal = await getInternalSchedulerDump();
    const lastJobMap = await buildLastJobMap(internal.entries);
    const enrichedEntries = internal.entries.map(e => ({
      ...e,
      lastJobMs: lastJobMap.get(e.agentId) ?? null,
    }));
    return NextResponse.json({ ...health, internal: { ...internal, entries: enrichedEntries } });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const agents = await loadAgentsForCheck();
    const before = await getSchedulerHealth(agents);

    const installed: string[] = [];
    const installFailures: Array<{ id: string; error: string }> = [];
    for (const m of before.missing) {
      const agent = agents.find(a => a.id === m.id);
      if (!agent || !agent.schedule) continue;
      try {
        await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.project, agent.name);
        installed.push(m.expectedName);
      } catch (err) {
        installFailures.push({ id: m.id, error: errMsg(err) });
      }
    }

    const after = await getSchedulerHealth(agents);
    const internal = await getInternalSchedulerDump();
    const lastJobMap = await buildLastJobMap(internal.entries);
    const enrichedEntries = internal.entries.map(e => ({
      ...e,
      lastJobMs: lastJobMap.get(e.agentId) ?? null,
    }));
    return NextResponse.json({ before, after: { ...after, internal: { ...internal, entries: enrichedEntries } }, installed, installFailures });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
