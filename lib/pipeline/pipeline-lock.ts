import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

/**
 * True when the project's pipeline lock is held by an active (unfinished)
 * release meta-job. Child steps (test/review/push) kicked off by that release
 * should operate under the parent's lock rather than acquire their own — so
 * they use this to bypass the "lock already held" guard.
 */
export function isLockOwnedByActiveRelease(projectName: string): boolean {
  try {
    const lock = selfHealStaleLock(projectName);
    if (!lock) return false;
    const row = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, lock.lockedByJobId))
      .get();
    return !!row && row.kind === 'release' && row.finishedAt === null;
  } catch {
    return false;
  }
}

export interface PipelineLock {
  project: string;
  lockedByJobId: string;
  acquiredAt: number;
}

/**
 * Drop a lock if its holder job is terminal (finished) or no longer exists in
 * the jobs table. Returns the row that should be considered "current" — null
 * if the lock was healed away or never existed, or the original lock if its
 * holder is genuinely still running.
 *
 * Centralized here so every caller (acquireLock, getLock, scheduler skip check,
 * UI peeks) sees the same self-heal. Without this, a release that doesn't
 * cleanly call releaseLock — server crash, completion-hook ordering issue,
 * inline-job killed by `pnpm restart` — leaves an undead lock that blocks all
 * future pipeline runs until manually deleted from the DB.
 */
// Grace before auto-clearing a lock whose holder row can't be found. Short
// enough that a crashed-server lock unblocks within a minute, long enough
// that a freshly-acquired lock still appears valid in the brief window
// before the caller persists its own job row (or in unit tests that don't
// create job rows at all).
const MISSING_HOLDER_GRACE_SECONDS = 60;

function selfHealStaleLock(projectName: string): PipelineLock | null {
  const existing = getLockSync(projectName);
  if (!existing) return null;
  try {
    const holder = db.select().from(schema.jobs).where(eq(schema.jobs.id, existing.lockedByJobId)).get();
    if (holder && holder.finishedAt !== null) {
      // Holder finished without releasing — clear immediately.
      releaseLockSync(projectName);
      void drainPendingReleaseAsync(projectName);
      return null;
    }
    if (!holder) {
      // No row for the holder. Could be a fresh acquire that hasn't persisted
      // yet (tests, race window) — only heal if the lock has aged past the
      // grace period. Otherwise leave it alone.
      const ageSec = Date.now() / 1000 - existing.acquiredAt;
      if (ageSec > MISSING_HOLDER_GRACE_SECONDS) {
        releaseLockSync(projectName);
        void drainPendingReleaseAsync(projectName);
        return null;
      }
    }
  } catch {
    // DB hiccup — leave the lock alone rather than risk a false-clear.
    return existing;
  }
  return existing;
}

/**
 * Attempt to acquire a lock for a project's pipeline.
 * Returns the lock if acquired, or the existing lock if one is already held.
 *
 * Stale lock recovery: if the holder job is terminal or missing, the lock is
 * force-released before this attempt — see selfHealStaleLock.
 */
export async function acquireLock(projectName: string, jobId: string): Promise<{ acquired: boolean; lock: PipelineLock; blockingJobId?: string }> {
  const existing = selfHealStaleLock(projectName);
  if (existing) {
    // Holder is still running. Block new acquisitions for the lifetime of the
    // holder (preserves the original FCFS semantics).
    return { acquired: false, lock: existing, blockingJobId: existing.lockedByJobId };
  }

  // Acquire new lock
  const now = Date.now() / 1000;
  const lock: PipelineLock = {
    project: projectName,
    lockedByJobId: jobId,
    acquiredAt: now,
  };

  try {
    db.insert(schema.pipelineLocks)
      .values({
        project: projectName,
        lockedByJobId: jobId,
        acquiredAt: now,
      })
      .onConflictDoUpdate({
        target: schema.pipelineLocks.project,
        set: {
          lockedByJobId: jobId,
          acquiredAt: now,
        },
      })
      .run();
    return { acquired: true, lock };
  } catch (err) {
    throw new Error(`Failed to acquire pipeline lock for ${projectName}: ${err}`, { cause: err });
  }
}

/**
 * Release a lock if it's held by the given job. After deletion, fire a
 * pending-release drain so any agent run that completed while we held the
 * lock now gets its inherited release. Drain is async fire-and-forget —
 * we don't want completion-hook ordering to depend on it.
 */
export function releaseLock(projectName: string, jobId: string): void {
  const existing = getLockSync(projectName);
  if (existing && existing.lockedByJobId === jobId) {
    releaseLockSync(projectName);
    void drainPendingReleaseAsync(projectName);
  }
}

async function drainPendingReleaseAsync(projectName: string): Promise<void> {
  try {
    const { drainProjectRecoveryWork } = await import('./recovery-drain');
    await drainProjectRecoveryWork(projectName, '[pipeline-lock]');
  } catch (e) {
    console.error('[pipeline-lock] recovery drain failed for', projectName, e);
  }
  // Re-attempt in-memory queue — an agent queued before the release started
  // may have been deferred mid-release and is still waiting.
  try {
    const { drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
    await drainNextAgentRun(projectName);
  } catch (e) {
    console.error('[pipeline-lock] in-memory agent drain failed for', projectName, e);
  }
}

/**
 * Get the current lock for a project, if any. Self-heals stale entries: if
 * the recorded holder job is finished or no longer exists, the lock is
 * dropped and null is returned. This way every caller — release/push routes
 * pre-checking, scheduler skip checks, monitoring views — naturally ignores
 * undead locks instead of being blocked by them.
 */
export function getLock(projectName: string): PipelineLock | null {
  return selfHealStaleLock(projectName);
}

function getLockSync(projectName: string): PipelineLock | null {
  try {
    const row = db
      .select()
      .from(schema.pipelineLocks)
      .where(eq(schema.pipelineLocks.project, projectName))
      .get();

    if (!row) return null;

    return {
      project: row.project,
      lockedByJobId: row.lockedByJobId,
      acquiredAt: row.acquiredAt,
    };
  } catch {
    return null;
  }
}

function releaseLockSync(projectName: string): void {
  try {
    db.delete(schema.pipelineLocks)
      .where(eq(schema.pipelineLocks.project, projectName))
      .run();
  } catch {}
}
