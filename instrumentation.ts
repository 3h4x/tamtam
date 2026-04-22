// Exported so tests can await the reinstall loop deterministically. In
// production we fire-and-forget from register() so port 1337 binds
// immediately — the PM2 subprocess storm (~30× delete/start/stop) runs in
// the background instead of blocking Next.js dev boot after HMR restarts.
export async function reinstallAgents(): Promise<void> {
  const { db, schema } = await import('./lib/db');
  const { isNotNull, eq, and } = await import('drizzle-orm');
  const { installAgentSchedule, isAgentScheduleLoaded } = await import('./lib/agent-scheduler');

  const agents = db
    .select()
    .from(schema.agents)
    .where(and(isNotNull(schema.agents.schedule), eq(schema.agents.enabled, true)))
    .all();

  for (const agent of agents) {
    if (!agent.schedule) continue;
    try {
      // Idempotent: if the pm2/launchctl entry is already loaded (common
      // after an HMR restart), skip the delete→start→stop cycle.
      if (await isAgentScheduleLoaded(agent.id, agent.runner, agent.project, agent.name)) continue;
      await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
      console.log(`[scheduler] reinstalled ${agent.project}/${agent.name} → ${agent.schedule}`);
    } catch (err) {
      console.error(`[scheduler] failed to reinstall ${agent.id}:`, err);
    }
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  void reinstallAgents();

  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;

  // Nightly DB cleanup: delete job rows older than job_row_retention_days.
  // Run once at startup (catches drift from long downtimes) then every 24 h.
  const runCleanup = async () => {
    try {
      const { runNightlyCleanup } = await import('./lib/retention');
      runNightlyCleanup();
      console.log('[retention] nightly cleanup completed');
    } catch (err) {
      console.error('[retention] nightly cleanup error:', err);
    }
  };
  runCleanup();
  setInterval(runCleanup, 24 * 60 * 60 * 1000);
}
