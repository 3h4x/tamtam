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
      cost_usd REAL,
      model TEXT,
      release_id TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('pipeline-lock', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let acquireLock: typeof import('@/lib/pipeline-lock').acquireLock;
  let releaseLock: typeof import('@/lib/pipeline-lock').releaseLock;
  let getLock: typeof import('@/lib/pipeline-lock').getLock;
  let isLockOwnedByActiveRelease: typeof import('@/lib/pipeline-lock').isLockOwnedByActiveRelease;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    listJobsMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));
    vi.doMock('@/lib/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: vi.fn(),
    }));

    const mod = await import('@/lib/pipeline-lock');
    acquireLock = mod.acquireLock;
    releaseLock = mod.releaseLock;
    getLock = mod.getLock;
    isLockOwnedByActiveRelease = mod.isLockOwnedByActiveRelease;
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
      listJobsMock.mockReturnValue([{ id: 'job-1', finishedAt: null }]);
      const result = await acquireLock('proj', 'job-2');
      expect(result.acquired).toBe(false);
      expect(result.blockingJobId).toBe('job-1');
    });

    it('force-releases stale lock when the holding job has finished', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'old-job', ${Date.now() / 1000 - 31 * 60})`
      );
      listJobsMock.mockReturnValue([{ id: 'old-job', finishedAt: Date.now() / 1000 - 100 }]);

      const result = await acquireLock('proj', 'new-job');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-job');
    });

    it('force-releases stale lock when the holding job is not found', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'ghost-job', ${Date.now() / 1000 - 31 * 60})`
      );
      listJobsMock.mockReturnValue([]);

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
      listJobsMock.mockReturnValue([{ id: 'release-done', finishedAt: Date.now() / 1000 - 5 }]);

      const result = await acquireLock('proj', 'new-release');
      expect(result.acquired).toBe(true);
      expect(result.lock.lockedByJobId).toBe('new-release');
    });

    it('immediately self-heals a fresh lock whose holder no longer exists', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'vanished', ${Date.now() / 1000 - 5})`
      );
      listJobsMock.mockReturnValue([]);

      const result = await acquireLock('proj', 'new-release');
      expect(result.acquired).toBe(true);
    });

    it('returns acquired:false when stale lock job is still running', async () => {
      testDb.sqlite.exec(
        `INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at) VALUES ('proj', 'long-running', ${Date.now() / 1000 - 31 * 60})`
      );
      listJobsMock.mockReturnValue([{ id: 'long-running', finishedAt: null }]);

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
});
