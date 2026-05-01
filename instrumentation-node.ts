// Loads enabled scheduled agents from the DB and arms the internal scheduler.
// In-process timers fire on cadence and POST to /api/agents/{id}/run — no
// PM2 cron involvement (that path silently no-op'd; see lib/internal-scheduler.ts).
export async function reinstallAgents(): Promise<void> {
  const { db, schema } = await import('./lib/db');
  const { eq } = await import('drizzle-orm');
  const { startInternalScheduler } = await import('./lib/scheduling/internal-scheduler');
  const { syncJobsPauseState } = await import('./lib/shared/job-control');
  const { getSettings } = await import('./lib/shared/config');
  type AgentInput = Parameters<typeof startInternalScheduler>[0][number];
  const { reconcilePm2Schedules } = await import('./lib/scheduling/agent-scheduler');

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
    const { scanFileAgents } = await import('./lib/agents/tamtam-file-agents');
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
    const { listJobs, probeJobStatus } = await import('./lib/jobs/job-storage');
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
  // Release meta-jobs have no PM2 process (pid=0) so probeJobStatus would
  // incorrectly mark them exit -1. Instead, find any finished pipeline step
  // for the project and let reconcileStaleRelease walk the chain — if all
  // steps are done it finalizes the release, otherwise it's a no-op.
  try {
    const { listJobs, reconcileStaleRelease, PIPELINE_STEP_KINDS } = await import('./lib/jobs/job-storage');
    const staleReleases = listJobs().filter(j => j.finishedAt === null && j.kind === 'release');
    for (const release of staleReleases) {
      const stepJob = listJobs().find(j =>
        j.project === release.project
        && PIPELINE_STEP_KINDS.has(j.kind)
        && j.finishedAt !== null
        && (j.startedAt ?? 0) >= (release.startedAt ?? 0) - 1
      );
      if (stepJob) {
        try { await reconcileStaleRelease(stepJob); } catch {}
      }
    }
  } catch (err) {
    console.error('[probe-sweep] release reconcile error:', err);
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
    const { readLegacyWorkflowFlags } = await import('./lib/skills/tamtam-file-config');

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
    const { listJobs, markDone } = await import('./lib/jobs/job-storage');
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

// One-shot backfill: populate the new `verdict` column for historical review
// jobs whose log files are still on disk. Jobs whose logs have already been
// pruned are irrecoverable and are left as null — they counted as parseFailed
// before this migration and will continue to do so, but future reviews will
// always have their verdict persisted at completion time.
// On every boot: store the verdict for any finished review job whose log is
// still on disk but whose verdict column is NULL. Runs in O(unpersisted_jobs)
// which is cheap once the initial backfill is done (only newly-finished reviews
// before their first `persistVerdict` call land here). This ensures verdicts
// survive future log pruning even for runs that completed before this fix.
async function backfillVerdicts(): Promise<void> {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  try {
    const { listJobs } = await import('./lib/jobs/job-storage');
    const { getVerdict } = await import('./lib/jobs/verdict');
    const { persistVerdict } = await import('./lib/jobs/storage');

    const reviewJobs = listJobs().filter(j => j.kind === 'review' && j.finishedAt !== null && j.exitCode === 0 && !j.verdict && !j.logPruned);
    let count = 0;
    for (const job of reviewJobs) {
      const v = getVerdict(job);
      if (v) { persistVerdict(job.id, v); count++; }
    }
    if (count > 0) console.log(`[boot] persisted verdict for ${count} review job(s) (log still on disk)`);
  } catch (err) {
    console.error('[boot] verdict backfill failed:', err);
  }
}

export async function registerNode(): Promise<void> {
  await migrateLegacyFileWorkflowFlags();
  void backfillVerdicts();
  void reapAbandonedInlineJobs();
  void reinstallAgents();

  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;

  // Nightly DB cleanup: delete job rows older than job_row_retention_days.
  // Run once at startup (catches drift from long downtimes) then every 24 h.
  const runCleanup = async () => {
    try {
      const { runNightlyCleanup } = await import('./lib/jobs/retention');
      runNightlyCleanup();
      console.log('[retention] nightly cleanup completed');
    } catch (err) {
      console.error('[retention] nightly cleanup error:', err);
    }
  };
  runCleanup();
  setInterval(runCleanup, 24 * 60 * 60 * 1000);

  const probeIntervalMs = parseInt(process.env.TAMTAM_PROBE_INTERVAL_MS ?? '', 10) || 30_000;
  setInterval(runProbeSweep, probeIntervalMs);

  // Quota drain ticker: every 60s, refresh the cached subscription quota and,
  // if we're below the block threshold, drain any releases that were deferred
  // while the 5h window was full.
  const { prefetchQuota, peekQuotaCache } = await import('@/lib/usage/claude-quota');
  const { listPendingReleaseProjects, drainPendingRelease } = await import('@/lib/pipeline/pending-release');
  const { getSettings } = await import('@/lib/shared/config');
  let lastDrainPct: number | null = null;
  setInterval(async () => {
    prefetchQuota();
    // Wait a beat for the prefetch to settle, then re-read cache.
    await new Promise((r) => setTimeout(r, 1500));
    const snap = peekQuotaCache();
    if (!snap) return;
    const limit = getSettings().budget_block_at_pct;
    const pct = snap.fiveHour.utilization;
    // Edge: dropped from over-limit back under. Drain pending releases.
    if (lastDrainPct != null && lastDrainPct >= limit && pct < limit) {
      const projects = listPendingReleaseProjects();
      for (const p of projects) {
        try { await drainPendingRelease(p); } catch (e) { console.error('[budget-drain] failed for', p, e); }
      }
    }
    lastDrainPct = pct;
  }, 60_000);
}
