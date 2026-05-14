import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS pipeline_locks (
      project text PRIMARY KEY,
      locked_by_job_id text NOT NULL,
      acquired_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      prompt text,
      pid integer NOT NULL DEFAULT 0,
      log_path text,
      started_at double precision NOT NULL DEFAULT 0,
      finished_at double precision,
      exit_code integer,
      seen boolean DEFAULT false,
      duration_ms integer,
      input_tokens integer,
      output_tokens integer,
      cache_read_tokens integer,
      cache_create_tokens integer,
      session_id text,
      user_prompt text,
      context_meta text,
      parent_job_id text,
      gh_issue_number integer,
      gh_issue_repo text,
      gh_issue_title text,
      log_pruned boolean DEFAULT false,
      verdict text,
      cost_usd double precision,
      model text,
      release_id text,
      aborted_at double precision,
      prompt_bytes integer,
      work_summary text,
      modified_files text,
      provider text
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      enabled boolean DEFAULT true,
      website text,
      qa_url text,
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
}

describe('pipeline-lock', () => {
  let handle: TestDbHandle;
  let acquireLock: typeof import('@/lib/pipeline/pipeline-lock').acquireLock;
  let releaseLock: typeof import('@/lib/pipeline/pipeline-lock').releaseLock;
  let getLock: typeof import('@/lib/pipeline/pipeline-lock').getLock;
  let isLockOwnedByActiveRelease: typeof import('@/lib/pipeline/pipeline-lock').isLockOwnedByActiveRelease;
  let reassignLock: typeof import('@/lib/pipeline/pipeline-lock').reassignLock;

  beforeAll(async () => {
    handle = await createTestPgDbEmpty();
    await applyDdl(handle);
  });

  afterAll(async () => {
    // Let any straggling fire-and-forget queries settle before closing.
    await new Promise((r) => setTimeout(r, 30));
    try {
      await handle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/pipeline/recovery-drain');
    vi.doUnmock('@/lib/agents/pending-agent-run');
    await handle.db.execute(sql.raw(
      'TRUNCATE pipeline_locks, jobs, settings, projects',
    ));
    vi.doMock('@/lib/db', () => ({
      db: handle.db,
      schema,
    }));

    const mod = await import('@/lib/pipeline/pipeline-lock');
    acquireLock = mod.acquireLock;
    releaseLock = mod.releaseLock;
    getLock = mod.getLock;
    isLockOwnedByActiveRelease = mod.isLockOwnedByActiveRelease;
    reassignLock = mod.reassignLock;
  });

  afterEach(async () => {
    // Short settle: lets fire-and-forget releaseLockAsync DELETEs land before
    // the next test truncates and inserts. 10ms is plenty for PGlite (in-proc).
    await new Promise((r) => setTimeout(r, 10));
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function insertJob(
    id: string,
    project: string,
    kind: string,
    startedAt: number,
    finishedAt: number | null = null,
    pid = 0,
  ) {
    await handle.db.execute(sql.raw(
      `INSERT INTO jobs (id, project, kind, pid, started_at, finished_at) VALUES ('${id}', '${project}', '${kind}', ${pid}, ${startedAt}, ${finishedAt === null ? 'NULL' : finishedAt})`,
    ));
    // pipeline-lock self-heal reads from the in-memory jobsCache, not the DB.
    // Populate the cache of the currently-loaded storage module so getJob()
    // can find the row.
    const storage = await import('@/lib/jobs/storage');
    storage.jobsCache.set(id, {
      id,
      project,
      kind,
      prompt: null,
      pid,
      logPath: null,
      startedAt,
      finishedAt,
      exitCode: null,
      seen: false,
    });
  }

  async function insertLock(project: string, jobId: string, acquiredAt: number) {
    await handle.db.execute(sql.raw(
      `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('${project}', '${jobId}', ${acquiredAt})`,
    ));
  }

  describe('getLock', () => {
    it('returns null when no lock exists', async () => {
      expect(await getLock('proj')).toBeNull();
    });

    it('returns lock data after acquiring', async () => {
      await acquireLock('proj', 'job-1');
      const lock = await getLock('proj');
      expect(lock).not.toBeNull();
      expect(lock!.project).toBe('proj');
      expect(lock!.lockedByJobId).toBe('job-1');
      expect(lock!.acquiredAt).toBeGreaterThan(0);
    });

    it('returns null for a different project', async () => {
      await acquireLock('proj-a', 'job-1');
      expect(await getLock('proj-b')).toBeNull();
    });

    it('self-heals: returns null when the holder job is already finished', async () => {
      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);
      expect(await getLock('proj')).toBeNull();
    });

    it('self-heal keeps a pending release queued when the drain is pause-blocked', async () => {
      vi.resetModules();
      const drainProjectRecoveryWorkMock = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainProjectRecoveryWorkMock,
      }));
      vi.doMock('@/lib/agents/pending-agent-run', () => ({
        drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
      }));

      const pendingMod = await import('@/lib/pipeline/pending-release');
      const mod2 = await import('@/lib/pipeline/pipeline-lock');

      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);
      pendingMod.setPendingRelease('proj');

      expect((await mod2.getLock('proj'))).toBeNull();
      await vi.waitFor(async () => expect(await pendingMod.getPendingRelease("proj")).toBe(true));
    });

    it('self-heal keeps a pending release queued when the drain throws', async () => {
      vi.resetModules();
      const drainProjectRecoveryWorkMock = vi.fn().mockRejectedValue(new Error('pm2 start failed'));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainProjectRecoveryWorkMock,
      }));
      vi.doMock('@/lib/agents/pending-agent-run', () => ({
        drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
      }));

      const pendingMod = await import('@/lib/pipeline/pending-release');
      const mod2 = await import('@/lib/pipeline/pipeline-lock');

      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);
      pendingMod.setPendingRelease('proj');

      expect((await mod2.getLock('proj'))).toBeNull();
      await vi.waitFor(async () => expect(await pendingMod.getPendingRelease("proj")).toBe(true));
    });

    it('self-heal keeps a pending release queued on retryable startup failure', async () => {
      vi.resetModules();
      const drainProjectRecoveryWorkMock = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainProjectRecoveryWorkMock,
      }));
      vi.doMock('@/lib/agents/pending-agent-run', () => ({
        drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
      }));

      const pendingMod = await import('@/lib/pipeline/pending-release');
      const mod2 = await import('@/lib/pipeline/pipeline-lock');

      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);
      pendingMod.setPendingRelease('proj');

      expect((await mod2.getLock('proj'))).toBeNull();
      await vi.waitFor(async () => expect(await pendingMod.getPendingRelease("proj")).toBe(true));
    });

    it('self-heals: still returns the lock while the holder is running', async () => {
      await insertLock('proj', 'live-release', Date.now() / 1000 - 5);
      await insertJob('live-release', 'proj', 'release', Date.now() / 1000 - 200, null);
      const lock = await getLock('proj');
      expect(lock).not.toBeNull();
      expect(lock!.lockedByJobId).toBe('live-release');
    });
  });

  describe('acquireLock', () => {
    it('acquires lock when none exists', async () => {
      const result = await acquireLock('proj', 'job-1');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('job-1');
      expect(result.lock.project).toBe('proj');
    });

    it('persists the lock so getLock returns it', async () => {
      await acquireLock('proj', 'job-1');
      expect((await getLock('proj'))).not.toBeNull();
    });

    it('returns acquired:false when a fresh lock is held by another job', async () => {
      await acquireLock('proj', 'job-1');
      await insertJob('job-1', 'proj', 'release', Date.now() / 1000, null);
      const result = await acquireLock('proj', 'job-2');
      expect(result.acquired).toBe(false);
      expect(result.blockingJobId).toBe('job-1');
    });

    it('force-releases stale lock when the holding job has finished', async () => {
      await insertLock('proj', 'old-job', Date.now() / 1000 - 31 * 60);
      await insertJob('old-job', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 100);

      const result = await acquireLock('proj', 'new-job');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-job');
    });

    it('force-releases stale lock when the holding job is not found', async () => {
      await insertLock('proj', 'ghost-job', Date.now() / 1000 - 31 * 60);

      const result = await acquireLock('proj', 'new-job');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-job');
    });

    it('immediately self-heals a fresh lock whose holder is already finished', async () => {
      await insertLock('proj', 'release-done', Date.now() / 1000 - 10);
      await insertJob('release-done', 'proj', 'release', Date.now() / 1000 - 100, Date.now() / 1000 - 5);

      const result = await acquireLock('proj', 'new-release');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-release');
    });

    it('self-heals a lock whose holder no longer exists once it ages past the grace window', async () => {
      await insertLock('proj', 'vanished', Date.now() / 1000 - 70);

      const result = await acquireLock('proj', 'new-release');
      expect(result.acquired).toBe(true);
    });

    it('returns acquired:false when stale lock job is still running', async () => {
      await insertLock('proj', 'long-running', Date.now() / 1000 - 31 * 60);
      await insertJob('long-running', 'proj', 'release', Date.now() / 1000 - 1900, null);

      const result = await acquireLock('proj', 'new-job');
      expect(result.acquired).toBe(false);
      expect(result.blockingJobId).toBe('long-running');
    });

    it('does not affect locks on other projects', async () => {
      await acquireLock('proj-a', 'job-a');
      const result = await acquireLock('proj-b', 'job-b');
      expect(result.acquired).toBe(true);
      expect((await getLock('proj-a'))!.lockedByJobId).toBe('job-a');
    });

    it('overwrites own lock when acquired again (idempotent upsert)', async () => {
      await acquireLock('proj', 'job-1');
      await releaseLock('proj', 'job-1');
      const result = await acquireLock('proj', 'job-1');
      expect(result.acquired).toBe(true);
    });
  });

  describe('releaseLock', () => {
    it('releases lock when owned by the given job', async () => {
      await acquireLock('proj', 'job-1');
      await releaseLock('proj', 'job-1');
      // releaseLock fires the delete asynchronously
      await vi.waitFor(async () => expect(await getLock('proj')).toBeNull());
    });

    it('does nothing when a different job tries to release', async () => {
      await acquireLock('proj', 'job-1');
      await releaseLock('proj', 'job-2');
      const lock = await getLock('proj');
      expect(lock).not.toBeNull();
      expect(lock!.lockedByJobId).toBe('job-1');
    });

    it('does not throw when no lock exists', async () => {
      await expect(releaseLock('proj', 'job-1')).resolves.not.toThrow();
    });

    it('only releases the named project, not other projects', async () => {
      await acquireLock('proj-a', 'job-a');
      await acquireLock('proj-b', 'job-b');
      await releaseLock('proj-a', 'job-a');
      await vi.waitFor(async () => expect(await getLock('proj-a')).toBeNull());
      expect((await getLock('proj-b'))).not.toBeNull();
    });

    it('calls the ordered recovery drain for the project when the lock is released', async () => {
      const drainMock = vi.fn().mockResolvedValue(undefined);
      vi.resetModules();
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainMock,
      }));
      const mod2 = await import('@/lib/pipeline/pipeline-lock');
      await mod2.acquireLock('proj', 'job-drain');
      await mod2.releaseLock('proj', 'job-drain');
      await vi.waitFor(() => expect(drainMock).toHaveBeenCalledWith('proj', '[pipeline-lock]'));
    });

    it('does not call the recovery drain when the wrong job tries to release', async () => {
      const drainMock = vi.fn().mockResolvedValue(undefined);
      vi.resetModules();
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainMock,
      }));
      const mod2 = await import('@/lib/pipeline/pipeline-lock');
      await mod2.acquireLock('proj', 'job-owner');
      await mod2.releaseLock('proj', 'job-other');
      await new Promise<void>((r) => setTimeout(r, 30));
      expect(drainMock).not.toHaveBeenCalled();
    });
  });

  describe('isLockOwnedByActiveRelease', () => {
    it('returns false when no lock exists', async () => {
      expect((await isLockOwnedByActiveRelease('proj'))).toBe(false);
    });

    it('returns true when locked by an active (unfinished) release job', async () => {
      await insertJob('release-1', 'proj', 'release', Date.now() / 1000, null);
      await acquireLock('proj', 'release-1');
      expect((await isLockOwnedByActiveRelease('proj'))).toBe(true);
    });

    it('returns false when locked by a finished release job', async () => {
      await insertJob('release-1', 'proj', 'release', Date.now() / 1000 - 60, Date.now() / 1000);
      await acquireLock('proj', 'release-1');
      expect((await isLockOwnedByActiveRelease('proj'))).toBe(false);
    });

    it('returns false when locked by an active non-release job (test kind)', async () => {
      await insertJob('test-1', 'proj', 'test', Date.now() / 1000, null);
      await acquireLock('proj', 'test-1');
      expect((await isLockOwnedByActiveRelease('proj'))).toBe(false);
    });

    it('returns false when locked by an active non-release job (review kind)', async () => {
      await insertJob('review-1', 'proj', 'review', Date.now() / 1000, null);
      await acquireLock('proj', 'review-1');
      expect((await isLockOwnedByActiveRelease('proj'))).toBe(false);
    });

    it('returns false when lock references a job not in the db', async () => {
      await acquireLock('proj', 'unknown-job-id');
      expect((await isLockOwnedByActiveRelease('proj'))).toBe(false);
    });
  });

  describe('reassignLock', () => {
    it('writes a new lock when none exists', async () => {
      reassignLock('proj', 'new-job');
      await vi.waitFor(async () => {
        const lock = await getLock('proj');
        expect(lock).not.toBeNull();
        expect(lock!.lockedByJobId).toBe('new-job');
        expect(lock!.project).toBe('proj');
      });
    });

    it('overwrites an existing lock regardless of current holder', async () => {
      await acquireLock('proj', 'placeholder-id');
      await insertJob('placeholder-id', 'proj', 'release', Date.now() / 1000, null);
      reassignLock('proj', 'real-job-id');
      await vi.waitFor(async () => {
        const lock = await getLock('proj');
        expect(lock!.lockedByJobId).toBe('real-job-id');
      });
    });

    it('updates acquiredAt to current time', async () => {
      const before = Date.now() / 1000;
      reassignLock('proj', 'job-1');
      await vi.waitFor(async () => {
        const lock = await getLock('proj');
        expect(lock).not.toBeNull();
        expect(lock!.acquiredAt).toBeGreaterThanOrEqual(before);
      });
      const after = Date.now() / 1000;
      const lock = await getLock('proj');
      expect(lock!.acquiredAt).toBeLessThanOrEqual(after + 1);
    });

    it('does not affect locks on other projects', async () => {
      await acquireLock('proj-a', 'job-a');
      await insertJob('job-a', 'proj-a', 'release', Date.now() / 1000, null);
      reassignLock('proj-b', 'job-b');
      await vi.waitFor(async () => {
        const b = await getLock('proj-b');
        expect(b).not.toBeNull();
        expect(b!.lockedByJobId).toBe('job-b');
      });
      expect((await getLock('proj-a'))!.lockedByJobId).toBe('job-a');
    });

    it('can overwrite a placeholder id (the start-release early-lock pattern)', async () => {
      const placeholder = 'proj-release-pending';
      await acquireLock('proj', placeholder);
      await insertJob('real-release-id', 'proj', 'release', Date.now() / 1000, null);
      reassignLock('proj', 'real-release-id');
      await vi.waitFor(async () => {
        const lock = await getLock('proj');
        expect(lock!.lockedByJobId).toBe('real-release-id');
      });
    });
  });
});
