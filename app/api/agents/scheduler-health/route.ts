import { NextResponse } from 'next/server';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSchedulerHealth, reconcilePm2Schedules, installAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { dumpInternalScheduler } from '@/lib/scheduling/internal-scheduler';
import { scanFileAgents } from '@/lib/agents/tamtam-file-agents';
import { errMsg } from '@/lib/shared/types';

function loadAgentsForCheck() {
  const dbAgents = db.select().from(schema.agents).all().map(a => ({
    id: a.id,
    project: a.project,
    name: a.name,
    runner: a.runner ?? 'pm2',
    schedule: a.schedule,
    enabled: !!a.enabled,
    prompt: a.prompt ?? '',
  }));
  const dbKeys = new Set(dbAgents.map(a => `${a.project}:${a.name}`));
  let enabledProjects: Array<{ name: string; path: string }> = [];
  try {
    enabledProjects = db.select().from(schema.projects).where(eq(schema.projects.enabled, true)).all();
  } catch { /* projects table may not exist in test envs */ }
  const fileAgents: typeof dbAgents = [];
  for (const p of enabledProjects) {
    try {
      for (const fa of scanFileAgents(p.path, p.name)) {
        if (dbKeys.has(`${fa.project}:${fa.name}`)) continue;
        fileAgents.push({
          id: fa.id,
          project: fa.project,
          name: fa.name,
          runner: fa.runner ?? 'pm2',
          schedule: fa.schedule,
          enabled: fa.enabled,
          prompt: fa.prompt,
        });
      }
    } catch { /* skip */ }
  }
  return [...dbAgents, ...fileAgents];
}

function buildLastJobMap(entries: { agentId: string; project: string; name: string }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    try {
      const row = db
        .select({ finishedAt: schema.jobs.finishedAt })
        .from(schema.jobs)
        .where(and(
          eq(schema.jobs.project, e.project),
          eq(schema.jobs.kind, `agent:${e.name}`),
          isNotNull(schema.jobs.finishedAt),
        ))
        .orderBy(desc(schema.jobs.finishedAt))
        .limit(1)
        .get();
      if (row?.finishedAt) map.set(e.agentId, row.finishedAt * 1000);
    } catch {
      // jobs table may not exist in test environments
    }
  }
  return map;
}

export async function GET() {
  try {
    const agents = loadAgentsForCheck();
    const health = await getSchedulerHealth(agents);
    const internal = dumpInternalScheduler();
    const lastJobMap = buildLastJobMap(internal.entries);
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
    const agents = loadAgentsForCheck();
    const before = await getSchedulerHealth(agents);

    const installed: string[] = [];
    const installFailures: Array<{ id: string; error: string }> = [];
    for (const m of before.missing) {
      const agent = agents.find(a => a.id === m.id);
      if (!agent || !agent.schedule) continue;
      try {
        await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
        installed.push(m.expectedName);
      } catch (err) {
        installFailures.push({ id: m.id, error: errMsg(err) });
      }
    }

    // Sweep any leftover PM2 cron entries from the legacy installPm2Schedule path —
    // they're never going to fire anyway and just clutter `pm2 list`.
    await reconcilePm2Schedules([]);

    const after = await getSchedulerHealth(agents);
    const internal = dumpInternalScheduler();
    const lastJobMap = buildLastJobMap(internal.entries);
    const enrichedEntries = internal.entries.map(e => ({
      ...e,
      lastJobMs: lastJobMap.get(e.agentId) ?? null,
    }));
    return NextResponse.json({ before, after: { ...after, internal: { ...internal, entries: enrichedEntries } }, installed, installFailures });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
