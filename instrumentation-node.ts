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

// Periodic probe sweep: Claude CLI sometimes hangs after emitting its final
// result event. `probeJobStatus` can detect this via the log's terminal
// result line, but only when *something* polls — the UI, a pipeline hook,
// or a duplicate-check. If nothing polls (e.g. no one has the history tab
// open and the agent isn't part of an active release chain), the hung
// process holds the job "running" indefinitely. A 30-second background
// sweep fixes that: list running Claude-backed jobs and probe them.
export async function runProbeSweep(): Promise<void> {
  try {
    const { listJobs, probeJobStatus } = await import('./lib/job-storage');
    const claudeKinds = new Set(['run', 'review', 'fix', 'fix-ci', 'fix-push']);
    const running = listJobs().filter(j =>
      j.finishedAt === null
      && (claudeKinds.has(j.kind) || j.kind.startsWith('agent:'))
    );
    for (const job of running) {
      try { await probeJobStatus(job); } catch {}
    }
  } catch (err) {
    console.error('[probe-sweep] error:', err);
  }
}

export async function registerNode(): Promise<void> {
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

  setInterval(runProbeSweep, 30_000);
}
