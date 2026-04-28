// Loads enabled scheduled agents from the DB and arms the internal scheduler.
// In-process timers fire on cadence and POST to /api/agents/{id}/run — no
// PM2 cron involvement (that path silently no-op'd; see lib/internal-scheduler.ts).
export async function reinstallAgents(): Promise<void> {
  const { db, schema } = await import('./lib/db');
  const { isNotNull, eq, and } = await import('drizzle-orm');
  const { startInternalScheduler } = await import('./lib/internal-scheduler');
  const { reconcilePm2Schedules } = await import('./lib/agent-scheduler');

  const allAgents = db.select().from(schema.agents).all();
  const enabled = allAgents.filter(a => a.enabled && a.schedule);

  startInternalScheduler(enabled.map(a => ({
    id: a.id,
    project: a.project,
    name: a.name,
    schedule: a.schedule,
    prompt: a.prompt ?? '',
    enabled: !!a.enabled,
  })));

  // One-time cleanup: PM2 cron entries from the legacy installAgentSchedule
  // path are dead weight now. Sweep them so `pm2 list` stops being noise.
  try {
    await reconcilePm2Schedules([]);
  } catch (err) {
    console.error('[scheduler] PM2 cleanup failed:', err);
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
