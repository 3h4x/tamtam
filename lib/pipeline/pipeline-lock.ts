import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { getJob } from '@/lib/jobs/storage';

/**
 * True when the project's pipeline lock is held by an active (unfinished)
 * release meta-job. Child steps (test/review/push) kicked off by that release
 * should operate under the parent's lock rather than acquire their own — so
 * they use this to bypass the "lock already held" guard.
 */
export async function isLockOwnedByActiveRelease(projectName: string): Promise<boolean> {
  try {
    const lock = await selfHealStaleLock(projectName);
    if (!lock) return false;
    const row = getJob(lock.lockedByJobId);
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
 */
// Grace before auto-clearing a lock whose holder row can't be found. Short
// enough that a crashed-server lock unblocks within a minute, long enough
// that a freshly-acquired lock still appears valid in the brief window
// before the caller persists its own job row (or in unit tests that don't
// create job rows at all).
const MISSING_HOLDER_GRACE_SECONDS = 60;

async function selfHealStaleLock(projectName: string): Promise<PipelineLock | null> {
  const existing = await getLockFromDb(projectName);
  if (!existing) return null;
  try {
    const holder = getJob(existing.lockedByJobId);
    if (holder && holder.finishedAt !== null) {
      releaseLockAsync(projectName);
      void drainPendingReleaseAsync(projectName);
      return null;
    }
    if (!holder) {
      const ageSec = Date.now() / 1000 - existing.acquiredAt;
      if (ageSec > MISSING_HOLDER_GRACE_SECONDS) {
        releaseLockAsync(projectName);
        void drainPendingReleaseAsync(projectName);
        return null;
      }
    }
  } catch {
    return existing;
  }
  return existing;
}

/**
 * Attempt to acquire a lock for a project's pipeline.
 * Returns the lock if acquired, or the existing lock if one is already held.
 */
export async function acquireLock(projectName: string, jobId: string): Promise<{ acquired: boolean; lock: PipelineLock; blockingJobId?: string }> {
  const existing = await selfHealStaleLock(projectName);
  if (existing) {
    return { acquired: false, lock: existing, blockingJobId: existing.lockedByJobId };
  }

  const now = Date.now() / 1000;
  const lock: PipelineLock = {
    project: projectName,
    lockedByJobId: jobId,
    acquiredAt: now,
  };

  try {
    await db.insert(schema.pipelineLocks)
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
      .execute();
    return { acquired: true, lock };
  } catch (err) {
    throw new Error(`Failed to acquire pipeline lock for ${projectName}: ${err}`, { cause: err });
  }
}

/**
 * Release a lock if it's held by the given job.
 */
export async function releaseLock(projectName: string, jobId: string): Promise<void> {
  const existing = await getLockFromDb(projectName);
  if (existing && existing.lockedByJobId === jobId) {
    releaseLockAsync(projectName);
    void drainPendingReleaseAsync(projectName);
  }
}

/**
 * Force-overwrite the lock to a new holder, bypassing the existing-holder check.
 */
export function reassignLock(projectName: string, newJobId: string): void {
  const now = Date.now() / 1000;
  void db.insert(schema.pipelineLocks)
    .values({ project: projectName, lockedByJobId: newJobId, acquiredAt: now })
    .onConflictDoUpdate({
      target: schema.pipelineLocks.project,
      set: { lockedByJobId: newJobId, acquiredAt: now },
    })
    .execute()
    .catch((e) => console.error('[pipeline-lock] reassignLock failed:', e));
}

async function drainPendingReleaseAsync(projectName: string): Promise<void> {
  try {
    const { drainProjectRecoveryWork } = await import('./recovery-drain');
    await drainProjectRecoveryWork(projectName, '[pipeline-lock]');
  } catch (e) {
    console.error('[pipeline-lock] recovery drain failed for', projectName, e);
  }
  try {
    const { drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
    await drainNextAgentRun(projectName);
  } catch (e) {
    console.error('[pipeline-lock] in-memory agent drain failed for', projectName, e);
  }
}

/**
 * Get the current lock for a project, if any. Self-heals stale entries.
 */
export async function getLock(projectName: string): Promise<PipelineLock | null> {
  return selfHealStaleLock(projectName);
}

async function getLockFromDb(projectName: string): Promise<PipelineLock | null> {
  try {
    const rows = await db
      .select()
      .from(schema.pipelineLocks)
      .where(eq(schema.pipelineLocks.project, projectName))
      .limit(1);

    const row = rows[0];
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

function releaseLockAsync(projectName: string): void {
  void db.delete(schema.pipelineLocks)
    .where(eq(schema.pipelineLocks.project, projectName))
    .execute()
    .catch((e) => console.error('[pipeline-lock] releaseLock failed:', e));
}
