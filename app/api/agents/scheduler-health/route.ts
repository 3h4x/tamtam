import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { getSchedulerHealth, reconcilePm2Schedules, installAgentSchedule } from '@/lib/agent-scheduler';
import { dumpInternalScheduler } from '@/lib/internal-scheduler';
import { errMsg } from '@/lib/types';

function loadAgentsForCheck() {
  return db.select().from(schema.agents).all().map(a => ({
    id: a.id,
    project: a.project,
    name: a.name,
    runner: a.runner ?? 'pm2',
    schedule: a.schedule,
    enabled: !!a.enabled,
    prompt: a.prompt ?? '',
  }));
}

export async function GET() {
  try {
    const agents = loadAgentsForCheck();
    const health = await getSchedulerHealth(agents);
    const internal = dumpInternalScheduler();
    return NextResponse.json({ ...health, internal });
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
    return NextResponse.json({ before, after: { ...after, internal }, installed, installFailures });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
