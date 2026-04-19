export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { db, schema } = await import('./lib/db');
  const { isNotNull, eq, and } = await import('drizzle-orm');
  const { installAgentSchedule } = await import('./lib/agent-scheduler');

  const agents = db
    .select()
    .from(schema.agents)
    .where(and(isNotNull(schema.agents.schedule), eq(schema.agents.enabled, true)))
    .all();

  for (const agent of agents) {
    if (!agent.schedule) continue;
    try {
      await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
      console.log(`[scheduler] reinstalled ${agent.project}/${agent.name} → ${agent.schedule}`);
    } catch (err) {
      console.error(`[scheduler] failed to reinstall ${agent.id}:`, err);
    }
  }
}
