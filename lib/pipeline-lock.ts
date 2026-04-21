import { db, schema } from './db';
import { eq } from 'drizzle-orm';
import { listJobs } from './job-storage';

/**
 * True when the project's pipeline lock is held by an active (unfinished)
 * release meta-job. Child steps (test/review/push) kicked off by that release
 * should operate under the parent's lock rather than acquire their own — so
 * they use this to bypass the "lock already held" guard.
 */
export function isLockOwnedByActiveRelease(projectName: string): boolean {
  try {
    const lock = getLockSync(projectName);
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

const STALE_LOCK_TIMEOUT_SECONDS = 30 * 60; // 30 minutes

export interface PipelineLock {
  project: string;
  lockedByJobId: string;
  acquiredAt: number;
}

/**
 * Attempt to acquire a lock for a project's pipeline.
 * Returns the lock if acquired, or the existing lock if one is already held.
 *
 * Stale lock recovery: if the lock is older than STALE_LOCK_TIMEOUT_SECONDS
 * and the referenced job is terminal (finished), the lock is force-released.
 */
export async function acquireLock(projectName: string, jobId: string): Promise<{ acquired: boolean; lock: PipelineLock; blockingJobId?: string }> {
  // Check for existing lock
  const existing = getLockSync(projectName);

  if (existing) {
    // Self-heal: if the holder job is already terminal (or no longer exists),
    // release the stale lock immediately rather than waiting for the 30-min
    // timeout. Covers the rare case where finalizeReleaseJob skipped the
    // releaseLock call due to completion-hook ordering.
    const blockingJob = listJobs().find(j => j.id === existing.lockedByJobId);
    const holderFinished = blockingJob ? blockingJob.finishedAt !== null : false;
    if (holderFinished || !blockingJob) {
      releaseLockSync(projectName);
    } else {
      // Holder is still running. Preserve existing behavior: block new
      // acquisitions for the lifetime of the holder.
      return { acquired: false, lock: existing, blockingJobId: existing.lockedByJobId };
    }
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
 * Release a lock if it's held by the given job.
 */
export function releaseLock(projectName: string, jobId: string): void {
  const existing = getLockSync(projectName);
  if (existing && existing.lockedByJobId === jobId) {
    releaseLockSync(projectName);
  }
}

/**
 * Get the current lock for a project, if any.
 */
export function getLock(projectName: string): PipelineLock | null {
  return getLockSync(projectName);
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
