import { NextResponse } from 'next/server';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSchedulerHealth, installAgentSchedule, type InternalSchedulerDump, type SchedulerEntryDump } from '@/lib/scheduling/agent-scheduler';
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
  return dbAgents;
}

async function buildLastJobMap(entries: { agentId: string; project: string; name: string }[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const results = await Promise.all(
    entries.map(async (e) => {
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
        return { agentId: e.agentId, finishedAt: rows[0]?.finishedAt ?? null };
      } catch {
        // jobs table may not exist in test environments
        return null;
      }
    }),
  );
  for (const r of results) {
    if (r?.finishedAt) map.set(r.agentId, r.finishedAt * 1000);
  }
  return map;
}

async function buildInternalSchedulerDump(
  agents: Array<{ id: string; project: string; name: string; schedule: string | null; enabled: boolean }>,
): Promise<InternalSchedulerDump> {
  const { loadAgentCronStates, getAllAgentLastAttempts } = await import('@/lib/scheduling/agent-cron-state');
  const [cronStates, lastAttempts] = await Promise.all([
    loadAgentCronStates(),
    Promise.resolve(getAllAgentLastAttempts()),
  ]);
  const entries: SchedulerEntryDump[] = agents
    .filter((agent) => agent.schedule)
    .flatMap((agent) => {
      const cron = cronStates.get(agent.id);
      if (!cron) return [];

      const lastAttempt = lastAttempts.get(agent.id);
      const skipped = lastAttempt?.status === 'skipped';
      return [{
        agentId: agent.id,
        project: agent.project,
        name: agent.name,
        schedule: agent.schedule!,
        nextFireMs: cron.nextFireMs,
        fireCount: 0,
        lastFireMs: null,
        skippedCount: skipped ? 1 : 0,
        lastSkippedReason: skipped ? lastAttempt.reason : null,
        lastError: cron.lastError,
        enabled: agent.enabled,
      }];
    });
  return {
    started: cronStates.size > 0,
    paused: false,
    entries,
  };
}

async function computeSchedulerHealth(): Promise<Record<string, unknown>> {
  const agents = await loadAgentsForCheck();
  const [health, internal] = await Promise.all([
    getSchedulerHealth(agents),
    buildInternalSchedulerDump(agents),
  ]);
  const lastJobMap = await buildLastJobMap(internal.entries);
  const enrichedEntries = internal.entries.map(e => ({
    ...e,
    lastJobMs: lastJobMap.get(e.agentId) ?? null,
  }));
  return { ...health, internal: { ...internal, entries: enrichedEntries } };
}

// TTL + single-flight cache for the read-only GET. Computing health scans every
// project's filesystem for file-agents and fires one DB query per agent (~30),
// which saturates the pg pool; without this each poll re-ran the whole thing and
// head-of-line-blocked every other request on the single-process server (logos,
// RSC prefetches all queued behind it).
let _healthCache: { data: Record<string, unknown> | null; time: number } = { data: null, time: 0 };
let _healthInflight: { promise: Promise<Record<string, unknown> | null>; generation: number } | null = null;
let _healthCacheGeneration = 0;
const HEALTH_TTL = 20; // seconds

function clearSchedulerHealthCache(): void {
  _healthCache = { data: null, time: 0 };
  _healthCacheGeneration += 1;
  _healthInflight = null;
}

export async function GET() {
  try {
    const now = Date.now() / 1000;
    if (_healthCache.data && now - _healthCache.time < HEALTH_TTL) {
      return NextResponse.json(_healthCache.data);
    }
    if (!_healthInflight || _healthInflight.generation !== _healthCacheGeneration) {
      const generation = _healthCacheGeneration;
      const promise = computeSchedulerHealth()
        .then((d) => {
          if (generation === _healthCacheGeneration) {
            _healthCache = { data: d, time: Date.now() / 1000 };
          }
          return d;
        })
        .catch((err) => { console.error('[scheduler-health] refresh failed:', err); return _healthCache.data; })
        .finally(() => {
          if (_healthInflight?.promise === promise) _healthInflight = null;
        });
      _healthInflight = { promise, generation };
    }
    // Serve stale immediately if we have anything; only the cold first call awaits.
    if (_healthCache.data) return NextResponse.json(_healthCache.data);
    const fresh = await _healthInflight.promise;
    if (fresh == null) return NextResponse.json({ error: 'scheduler health unavailable' }, { status: 503 });
    return NextResponse.json(fresh);
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

    const [after, internal] = await Promise.all([
      getSchedulerHealth(agents),
      buildInternalSchedulerDump(agents),
    ]);
    const lastJobMap = await buildLastJobMap(internal.entries);
    const enrichedEntries = internal.entries.map(e => ({
      ...e,
      lastJobMs: lastJobMap.get(e.agentId) ?? null,
    }));
    // Schedules may have changed — drop the GET cache so the next poll recomputes.
    clearSchedulerHealthCache();
    return NextResponse.json({ before, after: { ...after, internal: { ...internal, entries: enrichedEntries } }, installed, installFailures });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
