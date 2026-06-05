// `reinstallAgents()` and the in-memory scheduler it armed were retired
// when graphile-cron took over (see `seedAgentCrons` + `startCronWorker`
// at the bottom of this file). Scheduled agents are now durable across
// restarts via graphile-worker's persistent job queue.

// Periodic probe sweep. Two responsibilities, both orthogonal to the
// release pipeline orchestration:
//
//   1. Claude CLI sometimes hangs after emitting its final result event.
//      `probeJobStatus` can detect this via the log's terminal result line,
//      but only when *something* polls. The sweep is that something.
//   2. Releases that blow past `releaseDeadlineAt` need to be aborted.
//
// The hook-failure recovery patterns (stale release reconcile, queued-agent
// drain, generic reconcile sweep, auto-resume of stuck releases, quota
// drain) used to live here too. They were removed when the workflow runtime
// became the only release path — its durability owns those concerns now.
export async function runProbeSweep(): Promise<void> {
  try {
    const jobStorage = await import('@/lib/jobs/job-storage');
    const { isClaudeBackedJobKind, getJobKind } = await import('@/lib/jobs/kinds');
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
  // Heal zombie rows: jobs the in-memory cache already marked finished but whose
  // `finished_at` DB write was dropped (DB unreachable at finalize). The probe
  // above can't catch these — it only re-probes cache-running jobs — so a stale
  // DB row would otherwise pin the durable agent-run slot and 409-block the
  // agent forever. Runs every sweep + once at boot.
  try {
    const { reconcileFinishedDbRows } = await import('@/lib/jobs/finished-row-reconcile');
    await reconcileFinishedDbRows();
  } catch (err) {
    console.error('[probe-sweep] finished-row reconcile error:', err);
  }
  try {
    const jobStorage = await import('@/lib/jobs/job-storage');
    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
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
  try {
    const { runReleaseReconcileSweep } = await import('@/lib/jobs/release-reconcile');
    await runReleaseReconcileSweep();
  } catch (err) {
    console.error('[probe-sweep] release reconcile sweep error:', err);
  }
  // Drain unconsumed job_completion_events. The inline completion-hook
  // chain (in lib/jobs/lifecycle.ts) handles the happy path; this drain is
  // the safety net for crashes/restarts between markDone's event insert
  // and the hook return.
  try {
    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();
  } catch (err) {
    console.error('[probe-sweep] job-completion-router error:', err);
  }
  try {
    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    await consumePipelineLockEvents();
  } catch (err) {
    console.error('[probe-sweep] pipeline-lock-router error:', err);
  }
  try {
    const { sampleRunningJobResources } = await import('@/lib/jobs/resource-sampler');
    await sampleRunningJobResources();
  } catch (err) {
    console.error('[probe-sweep] resource-sampler error:', err);
  }
  try {
    const { reconcileStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    await reconcileStrandedBranches();
  } catch (err) {
    console.error('[probe-sweep] stranded-branch reconcile error:', err);
  }
  // Safety net: drain in-memory agent queues for projects where nothing is
  // currently running. The primary drain path is the lifecycle hook that fires
  // drainNextAgentRun on every agent finish. But a race between the drain and
  // a concurrent agent start (e.g. boost claiming startingAgents before the
  // lifecycle check) causes the drain to return early without scheduling a
  // retry, leaving the queue stuck indefinitely. This sweep fires every 30 s —
  // cheap, idempotent (inFlight + hasAgentStartSlot guards in drainNextAgentRun
  // prevent re-entrant drains).
  try {
    const { listQueuedProjects, drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
    const { listJobs } = await import('@/lib/jobs/job-storage');
    const { isAgentJobKind } = await import('@/lib/jobs/kinds');
    const runningProjects = new Set(
      listJobs()
        .filter((j) => j?.finishedAt === null && isAgentJobKind(j?.kind))
        .map((j) => j.project),
    );
    for (const project of listQueuedProjects()) {
      if (!runningProjects.has(project)) {
        void drainNextAgentRun(project);
      }
    }
  } catch (err) {
    console.error('[probe-sweep] stalled-queue drain:', err);
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
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const { readLegacyWorkflowFlags } = await import('@/lib/skills/tamtam-file-config');

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
// the previous next-server's PID. That process is gone after a restart, so the
// probe sweep's generic pid-liveness check (process.kill(pid, 0)) sees it dead
// and eventually marks the row exit -1.
// Catch them here too: if contextMeta is intact, resume; otherwise reap.
async function reapAbandonedInlineJobs(): Promise<void> {
  try {
    const { listJobs, markDone } = await import('@/lib/jobs/job-storage');
    const orphaned = listJobs().filter(j =>
      j.finishedAt === null
      && (j.kind === 'mark-dod' || j.kind === 'pr-wait')
      && (j.pid === 0 || (j.kind === 'pr-wait' && j.pid !== process.pid))
    );
    let resumed = 0;
    let reaped = 0;
    for (const job of orphaned) {
      if (job.kind === 'pr-wait' && job.contextMeta) {
        let hasValidResumeMeta = false;
        try {
          const parsed = JSON.parse(job.contextMeta);
          hasValidResumeMeta = typeof parsed?.prNumber === 'number'
            && typeof parsed?.prRepo === 'string'
            && typeof parsed?.prUrl === 'string';
        } catch (err) {
          console.error(`[boot] pr-wait contextMeta parse failed for ${job.id}:`, err);
        }
        if (hasValidResumeMeta) {
          try {
            const { resumeBootPrWait } = await import('@/lib/pipeline/pr-wait-resume');
            const r = resumeBootPrWait(job.id);
            if (r.ok) {
              resumed += 1;
              console.log(`[boot] resumed pr-wait ${job.id} (server restarted mid-run)`);
              continue;
            }
            console.warn(`[boot] could not resume pr-wait ${job.id}: ${r.error} — reaping instead`);
          } catch (err) {
            console.error(`[boot] resumePrWait threw for ${job.id} — reaping instead:`, err);
          }
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
const MAX_BOOT_RESUMES = 3;

function readBootRecoveryAttempts(contextMeta: string | null | undefined): number {
  if (!contextMeta) return 0;
  try {
    const parsed = JSON.parse(contextMeta);
    const n = Number(parsed?.bootRecoveryAttempts);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function bumpBootRecoveryAttempts(contextMeta: string | null | undefined): { next: number; serialized: string } {
  let parsed: Record<string, unknown> = {};
  if (contextMeta) {
    try { parsed = JSON.parse(contextMeta) || {}; } catch { parsed = {}; }
  }
  const current = readBootRecoveryAttempts(contextMeta);
  const next = current + 1;
  parsed.bootRecoveryAttempts = next;
  return { next, serialized: JSON.stringify(parsed) };
}

function setStopReason(contextMeta: string | null | undefined, reason: string): string {
  let parsed: Record<string, unknown> = {};
  if (contextMeta) {
    try { parsed = JSON.parse(contextMeta) || {}; } catch { parsed = {}; }
  }
  parsed.stopReason = reason;
  return JSON.stringify(parsed);
}

// Workflow-ready signal. Resolved only when getWorld().start() returns,
// startup definitively fails, tests bypass the world, or no world is
// configured. Boot reap + recovery drain await this so they never fire
// before the workflow runtime has re-enqueued its persisted runs.
const WORKFLOW_READY_WATCHDOG_MS = 60_000;
let workflowReadyResolve: (() => void) | null = null;
const workflowReadyPromise: Promise<void> = new Promise((resolve) => {
  workflowReadyResolve = resolve;
});
function signalWorkflowReady(): void {
  if (workflowReadyResolve) {
    const r = workflowReadyResolve;
    workflowReadyResolve = null;
    r();
  }
}
function armWorkflowReadyWatchdog(): void {
  setTimeout(() => {
    if (workflowReadyResolve) {
      console.warn(`[boot] workflow world has not reported ready after ${WORKFLOW_READY_WATCHDOG_MS}ms; holding destructive boot recovery until startup returns or fails`);
    }
  }, WORKFLOW_READY_WATCHDOG_MS).unref?.();
}
export async function waitForWorkflowReady(): Promise<void> {
  await workflowReadyPromise;
}

export async function reapOrphanReleases(): Promise<void> {
  try {
    const { listJobs, markDone, updateJob } = await import('@/lib/jobs/job-storage');
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const { safeStartOrchestrator } = await import('@/lib/workflows/safe-start-orchestrator');

    const candidates = listJobs().filter(j => j.kind === 'release' && j.finishedAt === null);
    for (const job of candidates) {
      const releaseChildren = listJobs()
        .filter((candidate) => candidate.releaseId === job.id && candidate.id !== job.id)
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const runningChild = releaseChildren.find((candidate) => candidate.finishedAt === null);
      if (runningChild) continue;

      // Reap only when the project lock is absent, still owned by this
      // release, or stuck on the `${project}-release-pending` placeholder.
      // Any other owner means a different release legitimately owns the
      // project now.
      const lockRows = await db.select().from(schema.pipelineLocks).where(eq(schema.pipelineLocks.project, job.project)).limit(1);
      const lockRow = lockRows[0] ?? null;
      const placeholderId = `${job.project}-release-pending`;
      const lockedByThisRelease = !!lockRow && lockRow.lockedByJobId === job.id;
      const lockedByPlaceholder = !!lockRow && lockRow.lockedByJobId === placeholderId;
      const ownsOrPlaceholder = !lockRow || lockedByThisRelease || lockedByPlaceholder;
      if (!ownsOrPlaceholder) continue;

      // Only reap/resume once the last child has been quiet for a grace
      // window. Workflow-driven releases that complete cleanly finalize
      // themselves via the orchestrator's terminal-decision step; anything
      // stranded past this point really did get orphaned by a server
      // restart.
      const latestFinishedChild = releaseChildren.find((candidate) => candidate.finishedAt !== null) ?? null;
      const newestChildEdge = latestFinishedChild
        ? Math.max(latestFinishedChild.finishedAt || 0, latestFinishedChild.startedAt || 0)
        : 0;
      const quietLongEnough = newestChildEdge === 0 || Date.now() / 1000 - newestChildEdge >= ORPHAN_RELEASE_HANDOFF_GRACE_SEC;
      if (latestFinishedChild && !quietLongEnough) continue;
      let reapReason = latestFinishedChild
        ? `child ${latestFinishedChild.id} finished and resume budget exhausted (${MAX_BOOT_RESUMES})`
        : 'orchestrator died before the first child step';

      // Try to resume the chain when there is a finished child to hand off
      // from. Budget the attempts so a permanently broken release doesn't
      // ping-pong on every boot.
      if (latestFinishedChild) {
        const attempts = readBootRecoveryAttempts(job.contextMeta);
        if (attempts < MAX_BOOT_RESUMES) {
          const bump = bumpBootRecoveryAttempts(job.contextMeta);
          try {
            // Mutate the cached job object directly so a later markDone
            // (which saves the same cached object) doesn't overwrite the
            // boot-recovery metadata we just persisted. `updateJob` only
            // saves the passed object — it doesn't refresh the cache.
            job.contextMeta = bump.serialized;
            updateJob(job);
          } catch (err) {
            console.error(`[boot] failed to persist bootRecoveryAttempts for ${job.id}:`, err);
          }
          try {
            const resumed = await safeStartOrchestrator(latestFinishedChild.id, job.project, job.id, 'orphan-resume');
            if (resumed) {
              console.log(`[boot] resumed orphan release ${job.id} from child ${latestFinishedChild.id} (attempt ${bump.next}/${MAX_BOOT_RESUMES})`);
              continue;
            }
            console.error(`[boot] orphan resume failed for ${job.id}; falling through to reap`);
            reapReason = `child ${latestFinishedChild.id} finished but orphan resume dispatch failed`;
          } catch (err) {
            console.error(`[boot] orphan resume failed for ${job.id}; falling through to reap:`, err);
            reapReason = `child ${latestFinishedChild.id} finished but orphan resume dispatch threw`;
          }
        } else {
          // Budget exhausted: record stopReason on the release meta-job's
          // contextMeta before reaping so the trace shows why. Mutate the
          // cached object so the subsequent markDone(job, -1) preserves
          // the stopReason.
          try {
            job.contextMeta = setStopReason(job.contextMeta, `exceeded boot-recovery attempts (${MAX_BOOT_RESUMES})`);
            updateJob(job);
          } catch (err) {
            console.error(`[boot] failed to persist stopReason for ${job.id}:`, err);
          }
        }
      }

      // Release the lock if this orphan owns it (or it's stuck on the
      // unfinished placeholder).
      if (lockedByThisRelease || lockedByPlaceholder) {
        try { await db.delete(schema.pipelineLocks).where(eq(schema.pipelineLocks.project, job.project)).execute(); } catch {}
      }

      try {
        await markDone(job, -1);
        console.log(`[boot] reaped orphan release ${job.id} (${reapReason})`);
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
    const { listJobs } = await import('@/lib/jobs/job-storage');
    const { getVerdict } = await import('@/lib/jobs/verdict');
    const { persistVerdict } = await import('@/lib/jobs/storage');

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

async function drainBootRecoveryWork(): Promise<void> {
  try {
    const { drainAllRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    await drainAllRecoveryWork('[boot]');
  } catch (err) {
    console.error('[boot] drainBootRecoveryWork failed:', err);
  }
  // Sweep orphaned dev servers: any pidfile whose project has no active
  // agent/release. Runs AFTER recovery drain so re-enqueued work has been
  // marked active in DB and we don't kill a server about to be reused.
  try {
    const { sweepOrphanDevServers } = await import('@/lib/dev-server/lifecycle');
    const { stopped, kept } = await sweepOrphanDevServers();
    if (stopped.length || kept.length) {
      console.log(`[boot] dev-server sweep: stopped=[${stopped.join(',')}] kept=[${kept.join(',')}]`);
    }
  } catch (err) {
    console.error('[boot] dev-server sweep failed:', err);
  }
}

export async function registerNode(): Promise<void> {
  await migrateLegacyFileWorkflowFlags();
  try {
    const { loadFromDb } = await import('@/lib/jobs/storage');
    await loadFromDb();
  } catch (err) {
    console.error('[boot] jobs cache load failed:', err);
  }
  // Warm the projects cache before any worker / cron / pipeline step
  // tries to resolve a project path. Cold cache returns null which
  // surfaces as "project 'X' not found" from start-test / start-review,
  // failing the workflow run and orphaning the release.
  try {
    const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
    await refreshProjectsCacheSync();
  } catch (err) {
    console.error('[boot] projects cache warm failed:', err);
  }
  try {
    const { backfillIssueCruncherPrerequisites } = await import('@/lib/agents/default-agent-skills');
    await backfillIssueCruncherPrerequisites();
  } catch (err) {
    console.error('[boot] issue-cruncher prerequisite backfill failed:', err);
  }
  void backfillVerdicts();
  try {
    const { startSystemMetricsSampler } = await import('@/lib/shared/system-metrics');
    startSystemMetricsSampler();
  } catch (err) {
    console.error('[boot] system-metrics sampler start failed:', err);
  }
  const inlineReapPromise = reapAbandonedInlineJobs();
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    await inlineReapPromise;
  } else {
    void inlineReapPromise;
  }
  // reapOrphanReleases + drainBootRecoveryWork must NOT run until the
  // workflow world has finished starting and re-enqueued its persisted
  // runs. A fixed setTimeout(8000) was insufficient because
  // workflow-postgres-setup can take longer than 8s on cold boot — the
  // reaper would then mark healthy mid-flight releases as orphan exit=-1
  // a beat before the orchestrator would have picked them back up. Gate
  // on the explicit workflow-ready signal. A watchdog logs slow starts, but
  // it does not unblock destructive recovery: if the world is configured and
  // still starting, reaping is more dangerous than waiting.
  const bootRecoveryPromise = (async () => {
    try {
      await waitForWorkflowReady();
    } catch (err) {
      console.warn('[boot] workflow-ready wait failed; running reap anyway:', err);
    }
    await reapOrphanReleases();
    await drainBootRecoveryWork();
  })();
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) {
    void bootRecoveryPromise;
  }
  // reinstallAgents() retired with the in-memory scheduler — graphile-cron
  // (`seedAgentCrons` below) replaces it. Scheduled agents are durable
  // across restarts via graphile-worker's persistent job queue now.

  // One-shot probe at boot so we don't wait up to 30s for the first
  // interval tick to detect a Claude CLI process that hung before the
  // restart, or a release that already crossed its deadline.
  const probeSweepPromise = runProbeSweep();
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    await probeSweepPromise;
  } else {
    void probeSweepPromise;
  }

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

  // Arm the watchdog before workflow startup awaits that might block. The
  // watchdog is intentionally log-only; startup success/failure is the only
  // signal that can release destructive boot recovery.
  armWorkflowReadyWatchdog();

  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    // Tests don't start the world; let waiters proceed immediately.
    signalWorkflowReady();
    await bootRecoveryPromise;
    return;
  }

  // No world configured — boot reap can proceed immediately without
  // waiting for a world that's never going to start.
  if (!process.env.WORKFLOW_TARGET_WORLD) {
    signalWorkflowReady();
  }

  // Start workflow world (Postgres-backed durable orchestration). The world
  // is required for the only agent intake path; if WORKFLOW_TARGET_WORLD is
  // unset or the world fails to start, agent runs will fail when the route
  // tries to enqueue them.
  if (process.env.WORKFLOW_TARGET_WORLD) {
    // Schema migration + Postgres-world bootstrap only run when the
    // operator has *explicitly* set WORKFLOW_POSTGRES_URL — never against
    // DATABASE_URL. Sharing the live app DB with the workflow runtime
    // commingles two unrelated schemas and (worse) lets
    // `workflow-postgres-setup` touch tables it doesn't own. The
    // `WORKFLOW_TARGET_WORLD=local` path doesn't need Postgres at all;
    // skip both the spawn and the env propagation.
    const isPostgresWorld = process.env.WORKFLOW_TARGET_WORLD === 'postgres';
    if (isPostgresWorld && process.env.WORKFLOW_POSTGRES_URL) {
      try {
        const { spawn } = await import('node:child_process');
        const connectionString = process.env.WORKFLOW_POSTGRES_URL;
        await new Promise<void>((resolve) => {
          const child = spawn('pnpm', ['exec', 'workflow-postgres-setup'], {
            cwd: process.cwd(),
            env: { ...process.env, WORKFLOW_POSTGRES_URL: connectionString },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
          child.on('exit', (code) => {
            if (code !== 0) console.warn(`[workflow] schema migration failed (exit ${code}): ${stderr.slice(-500)}`);
            resolve();
          });
          child.on('error', (err) => {
            console.warn('[workflow] schema migration spawn failed:', err);
            resolve();
          });
        });
      } catch (err) {
        console.warn('[workflow] schema migration failed:', err);
      }
    } else if (isPostgresWorld && !process.env.WORKFLOW_POSTGRES_URL) {
      console.warn('[workflow] WORKFLOW_TARGET_WORLD=postgres but WORKFLOW_POSTGRES_URL is not set; workflow runtime will use its built-in default and is unlikely to work — set WORKFLOW_POSTGRES_URL explicitly.');
    }
    try {
      const { getWorld } = await import('workflow/runtime');
      await getWorld().start?.();
      console.log('[workflow] Postgres world started');
    } catch (err) {
      console.warn('[workflow] world failed to start:', err);
    } finally {
      // Whether the world started cleanly or threw, unblock the boot reap.
      // A throwing world can't recover persisted runs anyway, so the
      // reaper claiming orphans is the correct fallback.
      signalWorkflowReady();
    }
  }

  // Nightly DB cleanup: delete job rows older than job_row_retention_days.
  // Once at boot (catches drift from long downtimes); subsequent fires
  // come from the `system-cron` graphile-worker task (see system-cron-task.ts
  // wired below). The bare setInterval(runCleanup, 24h) was retired with
  // the in-memory scheduler — graphile-worker is durable across restarts.
  const runCleanup = async () => {
    try {
      const { runNightlyCleanup } = await import('@/lib/jobs/retention');
      runNightlyCleanup();
      console.log('[retention] nightly cleanup completed');
    } catch (err) {
      console.error('[retention] nightly cleanup error:', err);
    }
    // Also trim the workflow runtime's own traces — the runtime never prunes
    // them, so they grow unbounded without this sweep. The local file-backed
    // world and the Postgres world store traces differently, so prune the
    // one that's actually in use (mutually exclusive by WORKFLOW_TARGET_WORLD).
    try {
      const { getSettings } = await import('@/lib/shared/config');
      const retentionDays = getSettings().workflow_run_retention_days;
      if (process.env.WORKFLOW_TARGET_WORLD === 'local') {
        const { pruneLocalWorldRuns } = await import('@/lib/workflows/local-world-retention');
        const summary = pruneLocalWorldRuns({ retentionDays });
        if (summary.runsDeleted > 0 || summary.errorCount > 0) {
          console.log(`[retention] local workflow trim: runs=${summary.runsDeleted} steps=${summary.stepsDeleted} status=${summary.status}${summary.lastError ? ` err=${summary.lastError}` : ''}`);
        }
      } else {
        const { pruneOldWorkflowRuns } = await import('@/lib/workflows/cron/workflow-retention');
        const summary = await pruneOldWorkflowRuns({ retentionDays });
        if (summary.runsDeleted > 0 || summary.errorCount > 0) {
          console.log(`[retention] workflow trim: runs=${summary.runsDeleted} events=${summary.eventsDeleted} steps=${summary.stepsDeleted} status=${summary.status}${summary.lastError ? ` err=${summary.lastError}` : ''}`);
        }
      }
    } catch (err) {
      console.error('[retention] workflow trim error:', err);
    }
  };
  runCleanup();

  // Phase 4 cron (graphile-worker): always-on now. The in-memory
  // internal-scheduler.ts that ran in parallel during the verification
  // window has been retired in favor of this graphile-worker pool.
  if (process.env.WORKFLOW_TARGET_WORLD) {
    void (async () => {
      try {
        const [
          { seedAgentCrons },
          { seedSystemCron },
          { startCronWorker },
          { SYSTEM_CRON_JOB_KEY },
        ] = await Promise.all([
          import('@/lib/workflows/cron/seed-agent-crons'),
          import('@/lib/workflows/cron/seed-system-cron'),
          import('@/lib/workflows/cron/start-cron-worker'),
          import('@/lib/workflows/cron/system-cron-task'),
        ]);
        const { quickAddJob } = await import('graphile-worker');
        const { listEnabledScheduledAgents } = await import('@/lib/scheduling/internal-scheduler-helpers');

        const connectionString = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
        if (!connectionString) {
          console.warn('[cron] no postgres URL — graphile cron disabled');
          return;
        }

        // Ensure built-in system agents (retrieval-maintenance, …) exist for
        // every enabled project BEFORE the agent-cron seed pass — otherwise
        // they wouldn't be in the list `listEnabledScheduledAgents()`
        // returns, and their cron rows wouldn't be enqueued until the next
        // boot.
        try {
          const { seedSystemAgents } = await import('@/lib/agents/system/seed');
          const r = await seedSystemAgents();
          console.log(`[system-agents] seeded ${r.seeded} new, ${r.skipped} existing, ${r.dismissed} dismissed`);
        } catch (err) {
          console.error('[system-agents] seed failed:', err);
        }

        // Seed enqueues
        const agentSeed = await seedAgentCrons({
          connectionString,
          loadEnabledAgents: listEnabledScheduledAgents,
        });
        const systemSeed = await seedSystemCron({ connectionString });
        console.log(
          `[cron] seeded ${agentSeed.enqueued} agent crons (${agentSeed.preserved} preserved); ` +
            `system-cron: ${systemSeed.enqueued ? 'ok' : systemSeed.reason}`,
        );

        // Start the worker pool with both agent-cron + system-cron handlers
        await startCronWorker({
          connectionString,
          agentCronDeps: {
            loadAgent: async (agentId) => {
              const all = await listEnabledScheduledAgents();
              return all.find((a) => a.id === agentId) ?? null;
            },
            // Skip the fire (without breaking the chain — the cron task
            // re-enqueues itself either way) when global jobs-paused is on
            // or when the project is archived/paused. Each per-agent check
            // is cheap enough to run inline; the cache primed by
            // `listEnabledScheduledAgents` keeps the project lookup free.
            prereqSkipReason: async (agent) => {
              const { recordAgentAttempt } = await import('@/lib/scheduling/agent-cron-state');
              const skip = (reason: string): string => {
                recordAgentAttempt(agent.id, 'skipped', reason);
                return reason;
              };
              const { isJobsPaused } = await import('@/lib/shared/job-control');
              if (isJobsPaused()) return skip('jobs paused');
              const { isProjectArchived, isProjectPaused } = await import('@/lib/shared/enabled-projects');
              if (isProjectArchived(agent.project)) return skip('project archived');
              if (isProjectPaused(agent.project)) return skip('project paused');
              // Don't pile scheduled work onto an open PR. When the project's
              // HEAD is off the default branch, or a release-pipeline pr-wait
              // is in flight for it, every additional run accumulates on the
              // PR without ever being mergeable in a clean window. Skip until
              // the branch returns to default (PR merged + auto-switched
              // back) — the cron self-reenqueue keeps the schedule ticking.
              try {
                const { listJobs } = await import('@/lib/jobs/job-storage');
                const projectJobs = listJobs().filter(j => j.project === agent.project);
                const prWaitInFlight = projectJobs.some(j => j.kind === 'pr-wait' && j.finishedAt === null);
                if (prWaitInFlight) return skip('pr-wait in flight (awaiting merge)');
                // Release-first workflow: a release fires after every run and
                // must finish (green + pushed) before the next run starts —
                // otherwise each run piles more uncommitted work onto an
                // unshipped tree. Wait while a release pipeline is still in
                // flight for this project.
                const releaseRunning = projectJobs.some(j => j.kind === 'release' && j.finishedAt === null);
                if (releaseRunning) return skip('release pipeline is running');
                const { resolveProjectPath } = await import('@/lib/shared/project-data');
                const projPath = resolveProjectPath(agent.project);
                if (projPath) {
                  const { decidePrContext } = await import('@/lib/pipeline/pr-context');
                  const pr = await decidePrContext(projPath);
                  if (pr.shouldOpenPr) return skip(`on non-default branch '${pr.currentBranch}'`);
                  // Branch-freshness gate: refuse the scheduled fire when the
                  // working branch is behind origin/<default>. The
                  // stranded-branch reconciler is responsible for rebasing /
                  // pushing; the cron just waits it out. Skips the POST so we
                  // don't waste a route call on something the route would 409
                  // on anyway.
                  const { checkBranchFresh } = await import('@/lib/git/branch-freshness');
                  const freshness = await checkBranchFresh(projPath);
                  if (!freshness.fresh) return skip(freshness.reason);
                }
              } catch (err) {
                console.warn(`[cron] branch-state prereq check failed for ${agent.id}:`, err);
              }
              return null;
            },
            startAgentRun: async (agent, modelOverride) => {
              // Mirror the UI's "Run" button: POST { prompt } to the agent
              // run route. The route requires a body prompt (or skill list)
              // and rejects with 400 otherwise. The agent's own prompt is
              // the natural choice; fall back to a synthesized line when an
              // agent has neither prompt nor skills configured.
              //
              // The `x-tamtam-trigger: schedule` header lets the route apply
              // schedule-only guards (skip on non-default branch, refuse
              // disabled/no-schedule agents). Cron also runs prereqSkipReason
              // before this call, so most of those skips fire there first;
              // the header is the safety net.
              //
              // `model` body field is set on orchestrator boost fires when
              // the allocator decided to promote the tier — the route reads
              // it and uses it in place of the agent's stored model.
              const baseUrl = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
              const prompt = agent.prompt?.trim() || `Run agent ${agent.name}`;
              const body: Record<string, unknown> = { prompt };
              if (modelOverride) body.model = modelOverride;
              const res = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agent.id)}/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-tamtam-trigger': 'schedule' },
                body: JSON.stringify(body),
              });
              if (!res.ok) {
                console.warn(`[cron] agent ${agent.id} run POST returned ${res.status}`);
                return null;
              }
              const data = await res.json().catch(() => ({}));
              const jobId = (data?.runId ?? data?.jobId ?? null) as string | null;
              if (res.status === 202) {
                // 202 means the route queued the fire (pipeline_lock,
                // already-running same project, branch state). The fire is
                // not lost — queued_agent_runs / pending-agent-run drain it
                // when the blocker clears — but it didn't actually dispatch
                // a job, so distinguish in telemetry.
                const code = (data?.code ?? data?.status ?? 'queued') as string;
                console.log(`[cron] agent ${agent.id} queued at /run (code=${code})`);
                try {
                  const { recordAgentAttempt } = await import('@/lib/scheduling/agent-cron-state');
                  recordAgentAttempt(agent.id, 'queued', `queued at /run (${code})`);
                } catch { /* telemetry-only */ }
                return null;
              }
              try {
                const { recordAgentAttempt } = await import('@/lib/scheduling/agent-cron-state');
                recordAgentAttempt(agent.id, 'dispatched', jobId ?? 'started');
              } catch { /* telemetry-only */ }
              return jobId;
            },
            enqueueNextFire: async (agentId, runAt) => {
              await quickAddJob(
                { connectionString },
                'agent-cron',
                { agentId },
                { jobKey: `agent-cron-${agentId}`, jobKeyMode: 'replace', runAt, maxAttempts: 5 },
              );
            },
            runSystemAgent: async (agent) => {
              const { listJobs, probeJobStatus } = await import('@/lib/jobs/job-storage');
              const { getJobKind } = await import('@/lib/jobs/kinds');
              const kindKey = `agent:${agent.name}`;
              for (const job of listJobs()) {
                if (job.project !== agent.project || getJobKind(job.kind) !== kindKey || job.finishedAt !== null) continue;
                if ((await probeJobStatus(job)) === 'running') {
                  console.warn(`[cron] system agent ${agent.project}/${agent.name} already running as ${job.id} — skipping`);
                  return;
                }
              }
              const { getSystemAgentHandler } = await import('@/lib/agents/system');
              const handler = getSystemAgentHandler(agent.name);
              if (!handler) {
                console.warn(`[cron] system agent ${agent.project}/${agent.name} has no handler — skipping`);
                return;
              }
              await handler.run(agent);
            },
          },
          systemCronDeps: {
            runRetentionCleanup: runCleanup,
            enqueueNextFire: async (runAt) => {
              await quickAddJob(
                { connectionString },
                'system-cron',
                {},
                { jobKey: SYSTEM_CRON_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
          projectSweepDeps: {
            runSweep: async () => {
              const { runProjectSweep } = await import('@/lib/jobs/project-sweep-runner');
              await runProjectSweep();
            },
            isEnabled: async () => {
              // Force a fresh DB read — the cron fires every 5min, which is
              // way past the settings cache's 5s TTL. A bare `getSettings()`
              // returns DEFAULTS (with project_sweep_enabled=false) while
              // its background refresh kicks off; the task would then see
              // "disabled" even though the row says true.
              const { getSettings, initSettings } = await import('@/lib/shared/config');
              await initSettings();
              return !!getSettings().project_sweep_enabled;
            },
            enqueueNextFire: async (runAt) => {
              const { PROJECT_SWEEP_JOB_KEY } = await import('@/lib/workflows/cron/project-sweep-task');
              await quickAddJob(
                { connectionString },
                'project-sweep',
                {},
                { jobKey: PROJECT_SWEEP_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
          orchestratorTickDeps: {
            loadConfig: async () => {
              const { getSettings, initSettings } = await import('@/lib/shared/config');
              await initSettings();
              const s = getSettings();
              if (!s.orchestrator_enabled) return null;
              return {
                marginPct: s.orchestrator_boost_margin_pct,
                maxBoostsPerHour: s.orchestrator_max_boosts_per_hour,
              };
            },
            loadBridge: async () => {
              const baseUrl = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
              const res = await fetch(`${baseUrl}/api/stats/bridge`);
              if (!res.ok) throw new Error(`stats/bridge HTTP ${res.status}`);
              return res.json();
            },
            loadAgents: async () => {
              const { listEnabledScheduledAgents } = await import('@/lib/scheduling/internal-scheduler-helpers');
              const { getAllAgentLastDispatches } = await import('@/lib/scheduling/agent-cron-state');
              const { loadAllAgentFruitfulness } = await import('@/lib/agents/fruitfulness');
              const { loadBoostAgents } = await import('@/lib/orchestrator/boost-agent-loader');
              return loadBoostAgents({
                listAgents: listEnabledScheduledAgents,
                getDispatches: getAllAgentLastDispatches,
                loadFruitfulness: () => loadAllAgentFruitfulness({ limit: 10 }),
                onFruitfulnessError: (err) => {
                  console.warn('[orchestrator] fruitfulness load failed; continuing without stats:', err);
                },
              });
            },
            enqueueAgentFire: async (agentId, runAt, modelOverride) => {
              await quickAddJob(
                { connectionString },
                'agent-cron',
                modelOverride ? { agentId, modelOverride } : { agentId },
                { jobKey: `agent-cron-${agentId}`, jobKeyMode: 'replace', runAt, maxAttempts: 5 },
              );
            },
            enqueueNextFire: async (runAt) => {
              const { ORCHESTRATOR_TICK_JOB_KEY } = await import('@/lib/workflows/cron/orchestrator-tick-task');
              await quickAddJob(
                { connectionString },
                'orchestrator-tick',
                {},
                { jobKey: ORCHESTRATOR_TICK_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
            recordBoostRecommendations: async (decisions) => {
              const { upsertRecommendation } = await import('@/lib/recommendations/recommendations');
              await Promise.all(
                decisions.map((d) =>
                  upsertRecommendation({
                    project: d.project,
                    sourceKind: 'orchestrator',
                    sourceId: null,
                    agentId: d.agentId,
                    agentName: d.agentName,
                    type: 'orchestrator_boost',
                    title: d.modelOverride === 'smart'
                      ? `Boosted ${d.agentName} in smart mode`
                      : `Boosted ${d.agentName}`,
                    detail: d.reason,
                    // The extra run was already fired by the time we record it —
                    // this is a done-on-arrival AUTO note, so archive it straight
                    // into History rather than the Unresolved queue.
                    status: 'resolved',
                    payload: {
                      reason: d.reason,
                      modelOverride: d.modelOverride ?? null,
                    },
                  }),
                ),
              );
            },
            analyzeAgentHealth: async (candidates) => {
              const { analyzeAgentHealth } = await import('@/lib/orchestrator/agent-health-analysis');
              return analyzeAgentHealth(candidates);
            },
            loadLatestFinishedRunStartedAt: async (candidate) => {
              const { loadLatestFinishedScheduledRunStartedAt } = await import('@/lib/orchestrator/agent-health-analysis');
              return loadLatestFinishedScheduledRunStartedAt(candidate);
            },
            getProjectQueueCounts: async () => {
              const { listQueuedProjects, listQueuedAgents } = await import('@/lib/agents/pending-agent-run');
              const counts = new Map<string, number>();
              for (const project of listQueuedProjects()) {
                counts.set(project, listQueuedAgents(project).length);
              }
              return counts;
            },
          },
          usageSnapshotDeps: {
            loadBridge: async () => {
              const baseUrl = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
              const res = await fetch(`${baseUrl}/api/stats/bridge`);
              if (!res.ok) throw new Error(`stats/bridge HTTP ${res.status}`);
              return res.json();
            },
            upsertSnapshots: async (rows) => {
              const { db, schema } = await import('@/lib/db');
              const { sql: drizzleSql } = await import('drizzle-orm');
              if (rows.length === 0) return;
              const recordedAt = Date.now() / 1000;
              await db
                .insert(schema.usageHourlySnapshot)
                .values(rows.map((r) => ({ ...r, recordedAt })))
                .onConflictDoUpdate({
                  target: [
                    schema.usageHourlySnapshot.bucketTs,
                    schema.usageHourlySnapshot.provider,
                    schema.usageHourlySnapshot.windowKey,
                  ],
                  set: {
                    utilizationPct: drizzleSql`excluded.utilization_pct`,
                    elapsedPct: drizzleSql`excluded.elapsed_pct`,
                    projectedPct: drizzleSql`excluded.projected_pct`,
                    paceMarginPct: drizzleSql`excluded.pace_margin_pct`,
                    status: drizzleSql`excluded.status`,
                    inputTokens: drizzleSql`excluded.input_tokens`,
                    outputTokens: drizzleSql`excluded.output_tokens`,
                    cacheReadTokens: drizzleSql`excluded.cache_read_tokens`,
                    cacheCreateTokens: drizzleSql`excluded.cache_create_tokens`,
                    jobCount: drizzleSql`excluded.job_count`,
                    recordedAt: drizzleSql`excluded.recorded_at`,
                  },
                });
            },
            loadTokenAggregates: async (bucketStartMs, bucketEndMs) => {
              const { db, schema } = await import('@/lib/db');
              const { and, gte, lt, isNotNull, sql: drizzleSql } = await import('drizzle-orm');
              const rows = await db
                .select({
                  provider: schema.jobs.provider,
                  inputTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.inputTokens}), 0)::bigint`,
                  outputTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.outputTokens}), 0)::bigint`,
                  cacheReadTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.cacheReadTokens}), 0)::bigint`,
                  cacheCreateTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.cacheCreateTokens}), 0)::bigint`,
                  jobCount: drizzleSql<number>`COUNT(*)::int`,
                })
                .from(schema.jobs)
                .where(and(
                  isNotNull(schema.jobs.provider),
                  isNotNull(schema.jobs.finishedAt),
                  gte(schema.jobs.finishedAt, bucketStartMs / 1000),
                  lt(schema.jobs.finishedAt, bucketEndMs / 1000),
                ))
                .groupBy(schema.jobs.provider);
              const map = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; jobCount: number }>();
              for (const r of rows) {
                if (!r.provider) continue;
                map.set(r.provider, {
                  inputTokens: Number(r.inputTokens) || 0,
                  outputTokens: Number(r.outputTokens) || 0,
                  cacheReadTokens: Number(r.cacheReadTokens) || 0,
                  cacheCreateTokens: Number(r.cacheCreateTokens) || 0,
                  jobCount: Number(r.jobCount) || 0,
                });
              }
              return map;
            },
            enqueueNextFire: async (runAt) => {
              const { USAGE_SNAPSHOT_JOB_KEY } = await import('@/lib/workflows/cron/usage-snapshot-task');
              await quickAddJob(
                { connectionString },
                'usage-snapshot',
                {},
                { jobKey: USAGE_SNAPSHOT_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
          dbBackupDeps: {
            createBackup: async () => {
              const {
                createDatabaseBackup,
                getBackupDirectory,
                createBackupFilename,
              } = await import('@/lib/db/backup');
              const { join } = await import('path');
              const dir = getBackupDirectory();
              const dest = join(/*turbopackIgnore: true*/ dir, createBackupFilename());
              await createDatabaseBackup(dest);
              return dest;
            },
            pruneOld: async (justCreatedPath: string) => {
              const { pruneBackupFiles, getBackupDirectory } = await import('@/lib/db/backup');
              const { getSettings } = await import('@/lib/shared/config');
              const { basename } = await import('path');
              const s = getSettings();
              // Protect the dump we *just* created from this same prune
              // sweep. Otherwise `keepRecent=0` + `keepWeekly=0` would
              // delete the new file immediately, violating the retention
              // contract (the manual `/api/settings/backup` route already
              // does this).
              return pruneBackupFiles(getBackupDirectory(), {
                keepRecent: s.backup_retention_count,
                keepWeekly: s.backup_retention_weekly_count,
                protectedNames: [basename(justCreatedPath)],
              });
            },
            readConfig: async () => {
              // Refresh so toggling the interval/enabled in the UI is
              // honored on the very next fire without a server restart.
              const { getSettings, initSettings } = await import('@/lib/shared/config');
              await initSettings();
              const s = getSettings();
              return {
                enabled: !!s.db_backup_enabled,
                intervalMs: Math.max(1, s.db_backup_interval_minutes) * 60 * 1000,
              };
            },
            enqueueNextFire: async (runAt) => {
              const { DB_BACKUP_JOB_KEY } = await import('@/lib/workflows/cron/db-backup-task');
              await quickAddJob(
                { connectionString },
                'db-backup',
                {},
                { jobKey: DB_BACKUP_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
        });

        // Seed the initial db-backup job so the chain starts after boot
        // even on a fresh install. Idempotent (jobKey replaces any
        // already-queued one).
        try {
          await quickAddJob(
            { connectionString },
            'db-backup',
            {},
            {
              jobKey: 'db-backup',
              jobKeyMode: 'preserve_run_at',
              runAt: new Date(Date.now() + 15 * 60 * 1000),
              maxAttempts: 5,
            },
          );
        } catch (err) {
          console.warn('[db-backup] seed failed:', err);
        }

        try {
          const { seedProjectSweep } = await import('@/lib/workflows/cron/seed-project-sweep');
          await seedProjectSweep({ connectionString });
        } catch (err) {
          console.warn('[cron] seedProjectSweep failed:', err);
        }

        try {
          const { seedOrchestratorTick } = await import('@/lib/workflows/cron/seed-orchestrator-tick');
          await seedOrchestratorTick({ connectionString });
        } catch (err) {
          console.warn('[cron] seedOrchestratorTick failed:', err);
        }

        try {
          const { seedUsageSnapshot } = await import('@/lib/workflows/cron/seed-usage-snapshot');
          await seedUsageSnapshot({ connectionString });
        } catch (err) {
          console.warn('[cron] seedUsageSnapshot failed:', err);
        }

        console.log('[cron] graphile-worker cron pool started (agent-cron + system-cron + project-sweep + orchestrator-tick + usage-snapshot)');
      } catch (err) {
        console.error('[cron] boot failed:', err);
      }
    })();
  }

  const probeIntervalMs = parseInt(process.env.TAMTAM_PROBE_INTERVAL_MS ?? '', 10) || 30_000;
  if (!(process.env.VITEST || (process.env.NODE_ENV as string) === 'test')) {
    setInterval(runProbeSweep, probeIntervalMs);
  }

  // Note: the hook-failure recovery loops that used to live here
  // (drainStaleQueuedAgentRuns scheduler, reconcileRecovery sweep,
  // autoResumeStuck, quota drain ticker) were removed when the workflow
  // runtime became the only release path. The workflow runtime handles
  // those concerns via its own durability. The on-demand resume route at
  // /api/projects/by-project/<name>/release/<id>/resume remains available
  // for manual operator intervention.
}
