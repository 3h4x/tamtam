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
export async function migrateLegacyFileWorkflowFlags(): Promise<void> {
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
export async function reapAbandonedInlineJobs(): Promise<void> {
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
export function signalWorkflowReady(): void {
  if (workflowReadyResolve) {
    const r = workflowReadyResolve;
    workflowReadyResolve = null;
    r();
  }
}
export function armWorkflowReadyWatchdog(): void {
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
export async function backfillVerdicts(): Promise<void> {
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

export async function drainBootRecoveryWork(): Promise<void> {
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
