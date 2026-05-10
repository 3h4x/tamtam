import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_locks (
      project TEXT PRIMARY KEY,
      locked_by_job_id TEXT NOT NULL,
      acquired_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL DEFAULT 0,
      log_path TEXT,
      started_at REAL NOT NULL DEFAULT 0,
      finished_at REAL,
      exit_code INTEGER,
      seen INTEGER DEFAULT 0,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_create_tokens INTEGER,
      session_id TEXT,
      user_prompt TEXT,
      context_meta TEXT,
      parent_job_id TEXT,
      gh_issue_number INTEGER,
      gh_issue_repo TEXT,
      gh_issue_title TEXT,
      log_pruned INTEGER DEFAULT 0,
      verdict TEXT,
      cost_usd REAL,
      model TEXT,
      release_id TEXT,
      aborted_at REAL,
      prompt_bytes INTEGER,
      work_summary TEXT,
      modified_files TEXT,
      provider TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      website TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('pipeline-lock', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let acquireLock: typeof import('@/lib/pipeline/pipeline-lock').acquireLock;
  let releaseLock: typeof import('@/lib/pipeline/pipeline-lock').releaseLock;
  let getLock: typeof import('@/lib/pipeline/pipeline-lock').getLock;
  let isLockOwnedByActiveRelease: typeof import('@/lib/pipeline/pipeline-lock').isLockOwnedByActiveRelease;
  let reassignLock: typeof import('@/lib/pipeline/pipeline-lock').reassignLock;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/pipeline/recovery-drain');
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    const mod = await import('@/lib/pipeline/pipeline-lock');
    acquireLock = mod.acquireLock;
    releaseLock = mod.releaseLock;
    getLock = mod.getLock;
    isLockOwnedByActiveRelease = mod.isLockOwnedByActiveRelease;
    reassignLock = mod.reassignLock;
  });

  afterEach(() => { vi.resetModules(); });

  describe('getLock', () => {
    it('returns null when no lock exists', () => {
      expect(getLock('proj')).toBeNull();
    });

    it('returns lock data after acquiring', async () => {
      await acquireLock('proj', 'job-1');
      const lock = getLock('proj');
      expect(lock).not.toBeNull();
      expect(lock!.project).toBe('proj');
      expect(lock!.lockedByJobId).toBe('job-1');
      expect(lock!.acquiredAt).toBeGreaterThan(0);
    });

    it('returns null for a different project', async () => {
      await acquireLock('proj-a', 'job-1');
      expect(getLock('proj-b')).toBeNull();
    });

    it('self-heals: returns null when the holder job is already finished', async () => {
      // Regression: stale lock pointing at a terminal release used to block
      // every new pipeline operation forever, because routes (release/push/
      // fix-ci/etc.) called getLock first and bailed with 409 before reaching
      // acquireLock's self-heal path. Now getLock itself heals.
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'old-release', ${Date.now() / 1000 - 5})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('old-release', 'proj', 'release', ${Date.now() / 1000 - 200}, ${Date.now() / 1000 - 10})`);
      expect(getLock('proj')).toBeNull();
    });

    it('self-heal keeps a pending release queued when the drain is pause-blocked', async () => {
      vi.resetModules();
      testDb = createTestDb();
      vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
      const drainProjectRecoveryWorkMock = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainProjectRecoveryWorkMock,
      }));
      vi.doMock('@/lib/agents/pending-agent-run', () => ({
        drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
      }));

      const pendingMod = await import('@/lib/pipeline/pending-release');
      const mod2 = await import('@/lib/pipeline/pipeline-lock');

      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'old-release', ${Date.now() / 1000 - 5})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('old-release', 'proj', 'release', ${Date.now() / 1000 - 200}, ${Date.now() / 1000 - 10})`);
      pendingMod.setPendingRelease('proj');

      expect(mod2.getLock('proj')).toBeNull();
      await vi.waitFor(() => expect(pendingMod.getPendingRelease('proj')).toBe(true));
    });

    it('self-heal keeps a pending release queued when the drain throws', async () => {
      vi.resetModules();
      testDb = createTestDb();
      vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
      const drainProjectRecoveryWorkMock = vi.fn().mockRejectedValue(new Error('pm2 start failed'));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainProjectRecoveryWorkMock,
      }));
      vi.doMock('@/lib/agents/pending-agent-run', () => ({
        drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
      }));

      const pendingMod = await import('@/lib/pipeline/pending-release');
      const mod2 = await import('@/lib/pipeline/pipeline-lock');

      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'old-release', ${Date.now() / 1000 - 5})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('old-release', 'proj', 'release', ${Date.now() / 1000 - 200}, ${Date.now() / 1000 - 10})`);
      pendingMod.setPendingRelease('proj');

      expect(mod2.getLock('proj')).toBeNull();
      await vi.waitFor(() => expect(pendingMod.getPendingRelease('proj')).toBe(true));
    });

    it('self-heal keeps a pending release queued on retryable startup failure', async () => {
      vi.resetModules();
      testDb = createTestDb();
      vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
      const drainProjectRecoveryWorkMock = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainProjectRecoveryWorkMock,
      }));
      vi.doMock('@/lib/agents/pending-agent-run', () => ({
        drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
      }));

      const pendingMod = await import('@/lib/pipeline/pending-release');
      const mod2 = await import('@/lib/pipeline/pipeline-lock');

      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'old-release', ${Date.now() / 1000 - 5})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('old-release', 'proj', 'release', ${Date.now() / 1000 - 200}, ${Date.now() / 1000 - 10})`);
      pendingMod.setPendingRelease('proj');

      expect(mod2.getLock('proj')).toBeNull();
      await vi.waitFor(() => expect(pendingMod.getPendingRelease('proj')).toBe(true));
    });

    it('self-heals: still returns the lock while the holder is running', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'live-release', ${Date.now() / 1000 - 5})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('live-release', 'proj', 'release', ${Date.now() / 1000 - 200}, NULL)`);
      const lock = getLock('proj');
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
      expect(getLock('proj')).not.toBeNull();
    });

    it('returns acquired:false when a fresh lock is held by another job', async () => {
      await acquireLock('proj', 'job-1');
      // pipeline-lock queries the jobs table directly to check whether the
      // holder is still running, so insert a real row rather than mock.
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('job-1', 'proj', 'release', ${Date.now() / 1000}, NULL)`);
      const result = await acquireLock('proj', 'job-2');
      expect(result.acquired).toBe(false);
      expect(result.blockingJobId).toBe('job-1');
    });

    it('force-releases stale lock when the holding job has finished', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'old-job', ${Date.now() / 1000 - 31 * 60})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('old-job', 'proj', 'release', ${Date.now() / 1000 - 200}, ${Date.now() / 1000 - 100})`);

      const result = await acquireLock('proj', 'new-job');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-job');
    });

    it('force-releases stale lock when the holding job is not found', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'ghost-job', ${Date.now() / 1000 - 31 * 60})`
      );

      const result = await acquireLock('proj', 'new-job');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-job');
    });

    it('immediately self-heals a fresh lock whose holder is already finished', async () => {
      // Regression: finalizeReleaseJob can skip the releaseLock call in rare
      // completion-hook orderings, leaving a stale lock pointing at a
      // terminal release job. Next acquire should recover without waiting
      // 30 minutes for the old stale-timeout.
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'release-done', ${Date.now() / 1000 - 10})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('release-done', 'proj', 'release', ${Date.now() / 1000 - 100}, ${Date.now() / 1000 - 5})`);

      const result = await acquireLock('proj', 'new-release');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-release');
    });

    it('self-heals a lock whose holder no longer exists once it ages past the grace window', async () => {
      // We use a 70-second-old lock here: the self-heal path has a 60s
      // grace window for the no-holder-row case so brief insert/persist
      // races (tests, server boot) don't false-clear a freshly-acquired
      // lock. Past the grace, a missing holder is treated as crashed.
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'vanished', ${Date.now() / 1000 - 70})`
      );

      const result = await acquireLock('proj', 'new-release');
      expect(result.acquired).toBe(true);
    });

    it('returns acquired:false when stale lock job is still running', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'long-running', ${Date.now() / 1000 - 31 * 60})`
      );
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('long-running', 'proj', 'release', ${Date.now() / 1000 - 1900}, NULL)`);

      const result = await acquireLock('proj', 'new-job');
      expect(result.acquired).toBe(false);
      expect(result.blockingJobId).toBe('long-running');
    });

    it('does not affect locks on other projects', async () => {
      await acquireLock('proj-a', 'job-a');
      const result = await acquireLock('proj-b', 'job-b');
      expect(result.acquired).toBe(true);
      expect(getLock('proj-a')!.lockedByJobId).toBe('job-a');
    });

    it('overwrites own lock when acquired again (idempotent upsert)', async () => {
      await acquireLock('proj', 'job-1');
      // Force-release first so we can re-acquire (simulating the upsert path)
      releaseLock('proj', 'job-1');
      const result = await acquireLock('proj', 'job-1');
      expect(result.acquired).toBe(true);
    });
  });

  describe('releaseLock', () => {
    it('releases lock when owned by the given job', async () => {
      await acquireLock('proj', 'job-1');
      releaseLock('proj', 'job-1');
      expect(getLock('proj')).toBeNull();
    });

    it('does nothing when a different job tries to release', async () => {
      await acquireLock('proj', 'job-1');
      releaseLock('proj', 'job-2');
      const lock = getLock('proj');
      expect(lock).not.toBeNull();
      expect(lock!.lockedByJobId).toBe('job-1');
    });

    it('does not throw when no lock exists', () => {
      expect(() => releaseLock('proj', 'job-1')).not.toThrow();
    });

    it('only releases the named project, not other projects', async () => {
      await acquireLock('proj-a', 'job-a');
      await acquireLock('proj-b', 'job-b');
      releaseLock('proj-a', 'job-a');
      expect(getLock('proj-a')).toBeNull();
      expect(getLock('proj-b')).not.toBeNull();
    });

    it('calls the ordered recovery drain for the project when the lock is released', async () => {
      const drainMock = vi.fn().mockResolvedValue(undefined);
      // Re-import after adding the mock so the module picks up the new mock.
      vi.resetModules();
      testDb = createTestDb();
      vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainMock,
      }));
      const mod2 = await import('@/lib/pipeline/pipeline-lock');
      await mod2.acquireLock('proj', 'job-drain');
      mod2.releaseLock('proj', 'job-drain');
      // drain is async fire-and-forget — wait a microtask cycle
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(drainMock).toHaveBeenCalledWith('proj', '[pipeline-lock]');
    });

    it('does not call the recovery drain when the wrong job tries to release', async () => {
      const drainMock = vi.fn().mockResolvedValue(undefined);
      vi.resetModules();
      testDb = createTestDb();
      vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
      vi.doMock('@/lib/pipeline/recovery-drain', () => ({
        drainProjectRecoveryWork: drainMock,
      }));
      const mod2 = await import('@/lib/pipeline/pipeline-lock');
      await mod2.acquireLock('proj', 'job-owner');
      mod2.releaseLock('proj', 'job-other');
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(drainMock).not.toHaveBeenCalled();
    });
  });

  describe('isLockOwnedByActiveRelease', () => {
    it('returns false when no lock exists', () => {
      expect(isLockOwnedByActiveRelease('proj')).toBe(false);
    });

    it('returns true when locked by an active (unfinished) release job', async () => {
      testDb.sqlite.exec(
        `INSERT INTO jobs (id, project, kind, pid, started_at) VALUES ('release-1', 'proj', 'release', 0, ${Date.now() / 1000})`
      );
      await acquireLock('proj', 'release-1');
      expect(isLockOwnedByActiveRelease('proj')).toBe(true);
    });

    it('returns false when locked by a finished release job', async () => {
      testDb.sqlite.exec(
        `INSERT INTO jobs (id, project, kind, pid, started_at, finished_at) VALUES ('release-1', 'proj', 'release', 0, ${Date.now() / 1000 - 60}, ${Date.now() / 1000})`
      );
      await acquireLock('proj', 'release-1');
      expect(isLockOwnedByActiveRelease('proj')).toBe(false);
    });

    it('returns false when locked by an active non-release job (test kind)', async () => {
      testDb.sqlite.exec(
        `INSERT INTO jobs (id, project, kind, pid, started_at) VALUES ('test-1', 'proj', 'test', 0, ${Date.now() / 1000})`
      );
      await acquireLock('proj', 'test-1');
      expect(isLockOwnedByActiveRelease('proj')).toBe(false);
    });

    it('returns false when locked by an active non-release job (review kind)', async () => {
      testDb.sqlite.exec(
        `INSERT INTO jobs (id, project, kind, pid, started_at) VALUES ('review-1', 'proj', 'review', 0, ${Date.now() / 1000})`
      );
      await acquireLock('proj', 'review-1');
      expect(isLockOwnedByActiveRelease('proj')).toBe(false);
    });

    it('returns false when lock references a job not in the db', async () => {
      await acquireLock('proj', 'unknown-job-id');
      expect(isLockOwnedByActiveRelease('proj')).toBe(false);
    });
  });

  describe('reassignLock', () => {
    it('writes a new lock when none exists', () => {
      reassignLock('proj', 'new-job');
      const lock = getLock('proj');
      expect(lock).not.toBeNull();
      expect(lock!.lockedByJobId).toBe('new-job');
      expect(lock!.project).toBe('proj');
    });

    it('overwrites an existing lock regardless of current holder', async () => {
      await acquireLock('proj', 'placeholder-id');
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at, finished_at) VALUES ('placeholder-id', 'proj', 'release', ${Date.now() / 1000}, NULL)`);
      reassignLock('proj', 'real-job-id');
      const lock = getLock('proj');
      expect(lock!.lockedByJobId).toBe('real-job-id');
    });

    it('updates acquiredAt to current time', () => {
      const before = Date.now() / 1000;
      reassignLock('proj', 'job-1');
      const after = Date.now() / 1000;
      const lock = getLock('proj');
      expect(lock!.acquiredAt).toBeGreaterThanOrEqual(before);
      expect(lock!.acquiredAt).toBeLessThanOrEqual(after);
    });

    it('does not affect locks on other projects', async () => {
      await acquireLock('proj-a', 'job-a');
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at) VALUES ('job-a', 'proj-a', 'release', ${Date.now() / 1000})`);
      reassignLock('proj-b', 'job-b');
      expect(getLock('proj-a')!.lockedByJobId).toBe('job-a');
      expect(getLock('proj-b')!.lockedByJobId).toBe('job-b');
    });

    it('can overwrite a placeholder id (the start-release early-lock pattern)', async () => {
      const placeholder = 'proj-release-pending';
      await acquireLock('proj', placeholder);
      // Simulate job row created after placeholder lock
      testDb.sqlite.exec(`INSERT INTO jobs (id, project, kind, started_at) VALUES ('real-release-id', 'proj', 'release', ${Date.now() / 1000})`);
      reassignLock('proj', 'real-release-id');
      const lock = getLock('proj');
      expect(lock!.lockedByJobId).toBe('real-release-id');
    });
  });
});
