// Loads enabled scheduled agents from the DB and arms the internal scheduler.
// In-process timers fire on cadence and POST to /api/agents/{id}/run — no
// PM2 cron involvement (that path silently no-op'd; see lib/internal-scheduler.ts).
export async function reinstallAgents(): Promise<void> {
  const { db, schema } = await import('./lib/db');
  const { eq } = await import('drizzle-orm');
  const { startInternalScheduler } = await import('./lib/internal-scheduler');
  type AgentInput = Parameters<typeof startInternalScheduler>[0][number];
  const { reconcilePm2Schedules } = await import('./lib/agent-scheduler');

  const allAgents = db.select().from(schema.agents).all();
  const dbEnabled: AgentInput[] = allAgents
    .filter(a => a.enabled && a.schedule)
    .map(a => ({
      id: a.id,
      project: a.project,
      name: a.name,
      schedule: a.schedule,
      prompt: a.prompt ?? '',
      enabled: !!a.enabled,
    }));

  // Also scan each enabled project for file-based agents (.tamtam/agents/*.md).
  // File agents take a back seat to DB agents with the same name (DB precedence
  // matches the rest of the system — see app/api/agents/route.ts GET).
  const dbAgentKeys = new Set(dbEnabled.map(a => `${a.project}:${a.name}`));
  const fileEnabled: AgentInput[] = [];
  try {
    const enabledProjects = db.select().from(schema.projects).where(eq(schema.projects.enabled, true)).all();
    const { scanFileAgents } = await import('./lib/tamtam-file-agents');
    for (const p of enabledProjects) {
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
          });
        }
      } catch (err) {
        console.error(`[scheduler] file-agent scan failed for ${p.name}:`, err);
      }
    }
  } catch { /* projects table may not exist (test env) */ }

  startInternalScheduler([...dbEnabled, ...fileEnabled]);

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
