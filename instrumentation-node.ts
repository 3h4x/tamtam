// Loads enabled scheduled agents from the DB and arms the internal scheduler.
// In-process timers fire on cadence and POST to /api/agents/{id}/run — no
// PM2 cron involvement (that path silently no-op'd; see lib/internal-scheduler.ts).
export async function reinstallAgents(): Promise<void> {
  const { db, schema } = await import('./lib/db');
  const { eq } = await import('drizzle-orm');
  const { startInternalScheduler } = await import('./lib/internal-scheduler');
  const { syncJobsPauseState } = await import('./lib/job-control');
  const { getSettings } = await import('./lib/config');
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

  try {
    syncJobsPauseState(getSettings().jobs_paused);
  } catch {
    // Settings table may be unavailable or partially mocked in tests.
  }
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

/**
 * One-shot migration: workflow flags (auto_push_enabled, pr_workflow_enabled,
 * gates, test cron …) used to be honored from `.tamtam/config.yml`. They are
 * now DB-only. To preserve existing behavior for installs that already had
 * those flags in their committed config, we copy each project's legacy flag
 * values into the DB exactly once.
 *
 * Idempotency comes from a per-project marker in the `settings` table:
 * `legacy_file_flags_migrated:<projectName>=1`. Once set, the project is
 * skipped on subsequent boots — so a user who later toggles a flag OFF in the
 * UI keeps that choice across restarts even if the legacy file still has the
 * key set to `true`.
 */
async function migrateLegacyFileWorkflowFlags(): Promise<void> {
  try {
    const { db, schema } = await import('./lib/db');
    const { eq } = await import('drizzle-orm');
    const { readLegacyWorkflowFlags } = await import('./lib/tamtam-file-config');

    const markerFor = (name: string) => `legacy_file_flags_migrated:${name}`;
    const isMigrated = (name: string): boolean => {
      const row = db.select().from(schema.settings).where(eq(schema.settings.key, markerFor(name))).get();
      return row?.value === '1';
    };
    const markMigrated = (name: string) => {
      db.insert(schema.settings)
        .values({ key: markerFor(name), value: '1' })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: '1' } })
        .run();
    };

    const projects = db.select().from(schema.projects).all();
    let migrated = 0;
    for (const proj of projects) {
      if (isMigrated(proj.name)) continue;
      if (!proj.path) continue;
      const legacy = readLegacyWorkflowFlags(proj.path);
      if (Object.keys(legacy).length === 0) continue;

      const updates: Partial<typeof schema.projects.$inferInsert> = {};
      // Each column: only seed when current DB row matches the column default
      // (false / null), implying it has never been set by the user.
      if (typeof legacy.pr_workflow_enabled === 'boolean' && !proj.prWorkflowEnabled) {
        updates.prWorkflowEnabled = legacy.pr_workflow_enabled;
      }
      if (typeof legacy.auto_commit_enabled === 'boolean' && !proj.autoCommitEnabled) {
        updates.autoCommitEnabled = legacy.auto_commit_enabled;
      }
      if (typeof legacy.auto_push_enabled === 'boolean' && !proj.autoPushEnabled) {
        updates.autoPushEnabled = legacy.auto_push_enabled;
      }
      if (typeof legacy.auto_pr_merge_enabled === 'boolean' && !proj.autoPrMergeEnabled) {
        updates.autoPrMergeEnabled = legacy.auto_pr_merge_enabled;
      }
      if (typeof legacy.release_after_run === 'boolean' && !proj.releaseAfterRun) {
        updates.releaseAfterRun = legacy.release_after_run;
      }
      if (typeof legacy.test_cron_enabled === 'boolean' && !proj.testCronEnabled) {
        updates.testCronEnabled = legacy.test_cron_enabled;
      }
      if (typeof legacy.test_cron_schedule === 'string' && !proj.testCronSchedule) {
        updates.testCronSchedule = legacy.test_cron_schedule;
      }
      if (typeof legacy.tests_disabled === 'boolean' && !proj.testsDisabled) {
        updates.testsDisabled = legacy.tests_disabled;
      }
      if (typeof legacy.review_disabled === 'boolean' && !proj.reviewDisabled) {
        updates.reviewDisabled = legacy.review_disabled;
      }
      // issue_auto_branch defaults to ON (null in DB == true), so only seed
      // when the file explicitly disables it AND the DB column is null.
      if (typeof legacy.issue_auto_branch === 'boolean' && proj.issueAutoBranch == null) {
        updates.issueAutoBranch = legacy.issue_auto_branch;
      }

      if (Object.keys(updates).length > 0) {
        db.update(schema.projects).set(updates).where(eq(schema.projects.name, proj.name)).run();
        migrated++;
      }
      // Mark migrated even when no DB updates were needed (file said all flags
      // were already at their default), so this project never re-evaluates.
      markMigrated(proj.name);
    }
    if (migrated > 0) {
      console.log(`[migration] seeded DB workflow flags from .tamtam/config.yml for ${migrated} project(s)`);
    }
  } catch (err) {
    console.error('[migration] legacy file workflow flag migration failed:', err);
  }
}

// In-process job kinds (mark-dod, pr-wait) run inside the next-server itself
// with pid=0. probeJobStatus deliberately treats them as "running" forever to
// avoid racing their self-finalization. That's fine while the server is alive,
// but a server restart kills the in-flight async function — leaving these
// rows stuck as `running` indefinitely with no markDone ever called. Sweep
// them at boot and mark them as `exit -1` so the UI stops lying about them.
async function reapAbandonedInlineJobs(): Promise<void> {
  try {
    const { listJobs, markDone } = await import('./lib/job-storage');
    const orphaned = listJobs().filter(j =>
      j.finishedAt === null
      && j.pid === 0
      && (j.kind === 'mark-dod' || j.kind === 'pr-wait')
    );
    for (const job of orphaned) {
      try {
        await markDone(job, -1);
        console.log(`[boot] reaped abandoned ${job.kind} job ${job.id} (server restarted mid-run)`);
      } catch (err) {
        console.error(`[boot] failed to reap ${job.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[boot] reapAbandonedInlineJobs failed:', err);
  }
}

export async function registerNode(): Promise<void> {
  await migrateLegacyFileWorkflowFlags();
  void reapAbandonedInlineJobs();
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
