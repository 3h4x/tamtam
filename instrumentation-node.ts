// Loads enabled scheduled agents from the DB and arms the internal scheduler.
// In-process timers fire on cadence and POST to /api/agents/{id}/run — no
// PM2 cron involvement (that path silently no-op'd; see lib/internal-scheduler.ts).
export async function reinstallAgents(): Promise<void> {
  const { db, schema } = await import('./lib/db');
  const { startInternalScheduler } = await import('./lib/scheduling/internal-scheduler');
  const { syncJobsPauseState } = await import('./lib/shared/job-control');
  const { getSettings } = await import('./lib/shared/config');
  const { listEnabledProjects } = await import('./lib/shared/enabled-projects');
  type AgentInput = Parameters<typeof startInternalScheduler>[0][number];
  const { reconcilePm2Schedules } = await import('./lib/scheduling/agent-scheduler');

  const allAgents = await db.select().from(schema.agents);
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
    const { scanFileAgents } = await import('./lib/agents/tamtam-file-agents');
    for (const p of listEnabledProjects()) {
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
    const jobStorage = await import('./lib/jobs/job-storage');
    const { isClaudeBackedJobKind, getJobKind } = await import('./lib/jobs/kinds');
    const pipelineStepKinds = 'PIPELINE_STEP_KINDS' in jobStorage && jobStorage.PIPELINE_STEP_KINDS instanceof Set
      ? jobStorage.PIPELINE_STEP_KINDS
      : new Set<string>();
    const running = jobStorage.listJobs().filter((job) => {
      try {
        const kind = getJobKind(job?.kind);
        return job?.finishedAt === null
          && (isClaudeBackedJobKind(kind) || pipelineStepKinds.has(kind));
      } catch {
        return false;
      }
    });
    for (const job of running) {
      try { await jobStorage.probeJobStatus(job); } catch {}
    }
  } catch (err) {
    console.error('[probe-sweep] error:', err);
  }
  // Reconcile stale release meta-jobs before timeout aborts. A release can
  // have every child step finished yet still have `finishedAt === null` until
  // the handoff reconciler finalizes the meta-job. Timeout logic must not
  // abort that already-complete chain.
  try {
    const jobStorage = await import('./lib/jobs/job-storage');
    const pipelineStepKinds = 'PIPELINE_STEP_KINDS' in jobStorage && jobStorage.PIPELINE_STEP_KINDS instanceof Set
      ? jobStorage.PIPELINE_STEP_KINDS
      : new Set<string>();
    const reconcileStaleRelease = 'reconcileStaleRelease' in jobStorage ? jobStorage.reconcileStaleRelease : undefined;
    const staleReleases = jobStorage.listJobs().filter(j => j.finishedAt === null && j.kind === 'release');
    for (const release of staleReleases) {
      const stepJob = jobStorage.listJobs().find(j =>
        j.project === release.project
        && pipelineStepKinds.has(j.kind)
        && j.finishedAt !== null
        && (j.startedAt ?? 0) >= (release.startedAt ?? 0) - 1
      );
      if (stepJob) {
        try { await reconcileStaleRelease?.(stepJob); } catch {}
      }
    }
  } catch (err) {
    console.error('[probe-sweep] release reconcile error:', err);
  }
  try {
    const jobStorage = await import('./lib/jobs/job-storage');
    const { abortActiveRelease } = await import('./lib/pipeline/release-abort');
    const now = Date.now();
    const expiredReleases = jobStorage.listJobs().filter(j =>
      j.kind === 'release'
      && j.finishedAt === null
      && typeof j.releaseDeadlineAt === 'number'
      && j.releaseDeadlineAt > 0
      && j.releaseDeadlineAt < now
    );
    for (const release of expiredReleases) {
      try {
        await abortActiveRelease(release.project, {
          reason: 'wall_clock_timeout',
          targetReleaseId: release.id,
        });
      } catch (err) {
        console.error(`[probe-sweep] release timeout abort failed for ${release.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[probe-sweep] release timeout sweep error:', err);
  }
}

/**
 * One-shot migration: workflow flags (auto_push_enabled, auto_commit_enabled,
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

    if (!schema.projects || !schema.settings?.key) return;

    const markerFor = (name: string) => `legacy_file_flags_migrated:${name}`;
    const isMigrated = async (name: string): Promise<boolean> => {
      const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, markerFor(name))).limit(1);
      return rows[0]?.value === '1';
    };
    const markMigrated = (name: string) => {
      void db.insert(schema.settings)
        .values({ key: markerFor(name), value: '1' })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: '1' } })
        .execute()
        .catch((e) => console.error('[migration] markMigrated failed:', e));
    };

    const projects = await db.select().from(schema.projects);
    let migrated = 0;
    for (const proj of projects) {
      if (await isMigrated(proj.name)) continue;
      if (!proj.path) continue;
      const legacy = readLegacyWorkflowFlags(proj.path);
      if (Object.keys(legacy).length === 0) continue;

      const updates: Partial<typeof schema.projects.$inferInsert> = {};
      // Each column: only seed when current DB row matches the column default
      // (false / null), implying it has never been set by the user.
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
        void db.update(schema.projects).set(updates).where(eq(schema.projects.name, proj.name)).execute().catch((e) => console.error('[migration] project update failed:', e));
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
// but a server restart kills the in-flight async function.
//
// pr-wait is *resumable*: its `contextMeta` records prNumber/prRepo/prUrl, and
// the polling loop is idempotent (GitHub will eventually finish CI). At boot
// we restart the wait loop on the same job row instead of marking it failed,
// because abandoning a wait that's only blocked on remote CI is wasteful —
// the operator would just have to re-trigger the merge by hand.
//
// mark-dod is short-lived (a single GraphQL roundtrip) and doesn't carry
// resume metadata, so we still reap it as exit -1.
//
// Older pr-wait rows created before pid=0 was the convention have pid set to
// the previous next-server's PID. They look like dead-PM2 jobs to the probe
// sweep but PM2 doesn't know them, so probe eventually marks them exit -1.
// Catch them here too: if contextMeta is intact, resume; otherwise reap.
async function reapAbandonedInlineJobs(): Promise<void> {
  try {
    const { listJobs, markDone } = await import('./lib/jobs/job-storage');
    const orphaned = listJobs().filter(j =>
      j.finishedAt === null
      && (j.kind === 'mark-dod' || j.kind === 'pr-wait')
      && (j.pid === 0 || (j.kind === 'pr-wait' && j.pid !== process.pid))
    );
    let resumed = 0;
    let reaped = 0;
    for (const job of orphaned) {
      if (job.kind === 'pr-wait' && job.contextMeta) {
        try {
          const { resumePrWait } = await import('./lib/pipeline/start-pr-wait');
          const r = resumePrWait(job.id);
          if (r.ok) {
            resumed += 1;
            console.log(`[boot] resumed pr-wait ${job.id} (server restarted mid-run)`);
            continue;
          }
          console.warn(`[boot] could not resume pr-wait ${job.id}: ${r.error} — reaping instead`);
        } catch (err) {
          console.error(`[boot] resumePrWait threw for ${job.id}:`, err);
        }
      }
      try {
        await markDone(job, -1);
        reaped += 1;
        console.log(`[boot] reaped abandoned ${job.kind} job ${job.id} (server restarted mid-run)`);
      } catch (err) {
        console.error(`[boot] failed to reap ${job.id}:`, err);
      }
    }
    if (resumed > 0 || reaped > 0) {
      console.log(`[boot] inline-job sweep: resumed=${resumed} reaped=${reaped}`);
    }
  } catch (err) {
    console.error('[boot] reapAbandonedInlineJobs failed:', err);
  }
}

// A release meta-job whose orchestrator died (PM2/Next.js restart between
// `createReleaseJob` and the first-step kickoff) leaves a `release` row
// finishedAt=null, a bash monitor process polling for hours, and — critically —
// no child step rows + no pipeline_locks entry. New release attempts then
// see `isReleasePipelineRunning` = true (because the bash monitor is alive)
// and bounce with "Release pipeline already running for X" until the monitor
// times out 4h later. Reap them at boot.
const ORPHAN_RELEASE_HANDOFF_GRACE_SEC = 5;

export async function reapOrphanReleases(): Promise<void> {
  try {
    const { listJobs, markDone, reconcileStaleRelease, getJob } = await import('./lib/jobs/job-storage');
    const { db, schema } = await import('./lib/db');
    const { exec } = await import('./lib/shared/shell');
    const { eq } = await import('drizzle-orm');

    const candidates = listJobs().filter(j => j.kind === 'release' && j.finishedAt === null);
    for (const job of candidates) {
      const releaseChildren = listJobs()
        .filter((candidate) => candidate.releaseId === job.id && candidate.id !== job.id)
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const runningChild = releaseChildren.find((candidate) => candidate.finishedAt === null);
      if (runningChild) continue;

      // Reap/reconcile only when the project lock is absent, still owned by
      // this release, or stuck on the `${project}-release-pending`
      // placeholder. Any other owner means a different release legitimately
      // owns the project now.
      const lockRows = await db.select().from(schema.pipelineLocks).where(eq(schema.pipelineLocks.project, job.project)).limit(1);
      const lockRow = lockRows[0] ?? null;
      const placeholderId = `${job.project}-release-pending`;
      const lockedByThisRelease = !!lockRow && lockRow.lockedByJobId === job.id;
      const lockedByPlaceholder = !!lockRow && lockRow.lockedByJobId === placeholderId;
      const ownsOrPlaceholder = !lockRow || lockedByThisRelease || lockedByPlaceholder;
      if (!ownsOrPlaceholder) continue;

      // If at least one child step finished before the restart, prefer
      // release reconciliation over force-reaping. That preserves the normal
      // "release exit code mirrors the completed chain" behavior while still
      // healing rows stranded after the last child's markDone path died.
      const latestFinishedChild = releaseChildren.find((candidate) => candidate.finishedAt !== null) ?? null;
      const newestChildEdge = latestFinishedChild
        ? Math.max(latestFinishedChild.finishedAt || 0, latestFinishedChild.startedAt || 0)
        : 0;
      const quietLongEnough = newestChildEdge === 0 || Date.now() / 1000 - newestChildEdge >= ORPHAN_RELEASE_HANDOFF_GRACE_SEC;
      if (latestFinishedChild && quietLongEnough) {
        try {
          await reconcileStaleRelease(latestFinishedChild);
        } catch (err) {
          console.error(`[boot] reconcileStaleRelease failed for orphan release ${job.id}:`, err);
        }
        if (getJob(job.id)?.finishedAt != null) {
          console.log(`[boot] reconciled stranded release ${job.id} from child ${latestFinishedChild.id}`);
          continue;
        }
      }

      if (latestFinishedChild && !quietLongEnough) continue;

      try {
        await exec('pm2', ['stop', job.id, '--silent'], { timeout: 5000 });
        await exec('pm2', ['delete', job.id, '--silent'], { timeout: 5000 });
      } catch { /* may not be in PM2 */ }

      // Release the lock if this orphan owns it (or it's stuck on the
      // unfinished placeholder).
      if (lockedByThisRelease || lockedByPlaceholder) {
        try { await db.delete(schema.pipelineLocks).where(eq(schema.pipelineLocks.project, job.project)).execute(); } catch {}
      }

      try {
        await markDone(job, -1);
        const reason = latestFinishedChild
          ? `child ${latestFinishedChild.id} finished but no continuation survived restart`
          : 'orchestrator died before the first child step';
        console.log(`[boot] reaped orphan release ${job.id} (${reason})`);
      } catch (err) {
        console.error(`[boot] failed to reap orphan release ${job.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[boot] reapOrphanReleases failed:', err);
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

export async function drainStalePendingReleases(): Promise<void> {
  try {
    const { listPendingReleaseProjects, drainPendingRelease } = await import('@/lib/pipeline/pending-release');
    const { getLock } = await import('@/lib/pipeline/pipeline-lock');
    const projects = await listPendingReleaseProjects();
    for (const p of projects) {
      // Skip if an active pipeline lock still exists — the drain will fire
      // naturally when that lock is released.
      if (await getLock(p)) continue;
      try { await drainPendingRelease(p); } catch (e) { console.error('[boot] pending-release drain failed for', p, e); }
    }
  } catch (err) {
    console.error('[boot] drainStalePendingReleases failed:', err);
  }
}

// At boot, drain any agents that were queued (due to a release lock) before a
// restart. If the lock is still active, the drain will fire naturally when it
// releases. If the lock is gone (clean finish before restart, or self-healed
// stale lock), fire immediately.
export async function drainStaleQueuedAgentRuns(): Promise<void> {
  try {
    const { schema } = await import('@/lib/db');
    if (!schema.queuedAgentRuns?.project) return;
    const { drainUnlockedQueuedAgentRuns } = await import('@/lib/pipeline/recovery-drain');
    await drainUnlockedQueuedAgentRuns('[boot][queued-agent-runs]');
  } catch (err) {
    console.error('[boot] drainStaleQueuedAgentRuns failed:', err);
  }
}

export async function drainQueuedWorkAfterBudgetRecovery(): Promise<void> {
  try {
    const { drainAllRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    await drainAllRecoveryWork('[budget-drain]');
  } catch (e) {
    console.error('[budget-drain] recovery retry failed:', e);
  }
}

async function drainBootRecoveryWork(): Promise<void> {
  try {
    const { drainAllRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    await drainAllRecoveryWork('[boot]');
  } catch (err) {
    console.error('[boot] drainBootRecoveryWork failed:', err);
  }
}

export async function registerNode(): Promise<void> {
  await migrateLegacyFileWorkflowFlags();
  try {
    const { loadFromDb } = await import('./lib/jobs/storage');
    await loadFromDb();
  } catch (err) {
    console.error('[boot] jobs cache load failed:', err);
  }
  try {
    const { backfillIssueCruncherPrerequisites } = await import('./lib/agents/default-agent-skills');
    await backfillIssueCruncherPrerequisites();
  } catch (err) {
    console.error('[boot] issue-cruncher prerequisite backfill failed:', err);
  }
  void backfillVerdicts();
  void reapAbandonedInlineJobs();
  void reapOrphanReleases();
  void drainBootRecoveryWork();
  void reinstallAgents();

  // Replay lifecycle hooks for any PM2 child that finished while the server
  // was down. Without this, a restart between a child's exit and the next
  // periodic sweep silently strands the pipeline (no follow-on step, no
  // `# release finished` line, lock held until the bash monitor times out).
  // Runs once at boot in addition to the 30-second interval below.
  void runProbeSweep();

  // Start Ollama via PM2 when retrieval is enabled
  try {
    const { getSettings: _getCfg } = await import('@/lib/shared/config');
    const _cfg = _getCfg();
    if (_cfg.retrieval_enabled) {
      const { ensureOllamaRunning } = await import('@/lib/agents/retrieval/ollama-lifecycle');
      void ensureOllamaRunning({
        ollamaUrl: _cfg.retrieval_ollama_url,
        embeddingModel: _cfg.retrieval_embedding_model,
        manageOllama: _cfg.retrieval_manage_ollama,
      }).catch((err) => console.warn('[retrieval] Ollama lifecycle error:', err));
    }
  } catch (err) {
    console.warn('[retrieval] boot check failed:', err);
  }

  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;

  // Start workflow world (Postgres-backed durable orchestration). The world
  // is required for the only agent intake path; if WORKFLOW_TARGET_WORLD is
  // unset or the world fails to start, agent runs will fail when the route
  // tries to enqueue them.
  if (process.env.WORKFLOW_TARGET_WORLD) {
    try {
      const { getWorld } = await import('workflow/runtime');
      await getWorld().start?.();
      console.log('[workflow] Postgres world started');
    } catch (err) {
      console.warn('[workflow] world failed to start:', err);
    }
  }

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
  setInterval(drainStaleQueuedAgentRuns, probeIntervalMs);

  // Reconcile orphaned recovery flags. drainPendingRelease clears its flag
  // and only re-stamps it on retryable failures, so any pending_release row
  // with no real reason to wait (no lock holding, no pause, nothing to ship)
  // is dropped on the next tick. Same for queued agent runs whose project is
  // unlocked. This is the safety net behind the lifecycle/pipeline-lock
  // hooks: if a hook ever fails to fire (server crash mid-write, code bug),
  // the next reconcile loop heals the state without manual intervention.
  const reconcileRecovery = async () => {
    try {
      const { drainAllRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
      await drainAllRecoveryWork('[reconcile]');
    } catch (err) {
      console.error('[reconcile] recovery sweep failed:', err);
    }
  };
  setInterval(reconcileRecovery, probeIntervalMs);

  // Auto-resume any release that was finalized as "done" while its chain
  // actually stopped at a non-terminal step that exited 0 (test/fix/review/
  // commit). Most common cause: completion hook crashed or server restarted
  // between markDone() and the next step spawning. The reconciler now
  // prevents this for live releases, but legacy stuck releases still need a
  // sweep. Runs every 5 min — slow on purpose, this is recovery, not a hot
  // path. The helper itself caps attempts per release id.
  const autoResumeStuck = async () => {
    try {
      const { autoResumeStuckReleases, autoResumeOrphanedAgentRuns } = await import('@/lib/pipeline/resume-stuck-release');
      await autoResumeStuckReleases();
      // Agent / terminal runs that finished cleanly but never triggered a
      // release on a project that has auto_commit / auto_push / release_after_run
      // on. These look "fine" individually (exit 0, no chain) but the user's
      // intent (ship after the agent finishes) was never honored.
      await autoResumeOrphanedAgentRuns();
    } catch (err) {
      console.error('[auto-resume] sweep failed:', err);
    }
  };
  void autoResumeStuck();
  setInterval(autoResumeStuck, 5 * 60 * 1000);

  // Quota drain ticker: every 5 min, refresh the cached subscription quota and,
  // if we're below the block threshold, drain any releases or DB-queued agent
  // fires that were deferred while the 5h window was full.
  const { prefetchQuota, peekQuotaCache } = await import('@/lib/usage/quota');
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
      await drainQueuedWorkAfterBudgetRecovery();
    }
    lastDrainPct = pct;
  }, 300_000);
}
