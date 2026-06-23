import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// Shared mock bag — populated in `beforeAll` once PGlite is up, then reused
// for every test. Hoisted so module-level `vi.mock` factories below capture
// stable references.
const mocks = vi.hoisted(() => {
  return {
    dbRef: { current: null as unknown as TestDbHandle['db'] },
    drainProjectRecoveryWork: vi.fn().mockResolvedValue(undefined),
    drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
    legacyInlineDrainEnabled: true,
  };
});

vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.dbRef.current;
  },
  schema,
}));

vi.mock('@/lib/pipeline/recovery-drain', () => ({
  drainProjectRecoveryWork: mocks.drainProjectRecoveryWork,
}));

vi.mock('@/lib/agents/pending-agent-run', () => ({
  drainNextAgentRun: mocks.drainNextAgentRun,
}));

vi.mock('@/lib/shared/config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shared/config')>('@/lib/shared/config');
  return {
    ...actual,
    getSettings: () => ({
      ...actual.buildConfigFromSettingsMap({}),
      legacy_pipeline_lock_inline_drain_enabled: mocks.legacyInlineDrainEnabled,
    }),
  };
});

// Import the subject and the modules it touches once at top-scope. They will
// all see the mocked `@/lib/db` (and friends).
import {
  acquireLock,
  releaseLock,
  getLock,
  isLockOwnedByActiveRelease,
  reassignLock,
} from '@/lib/pipeline/pipeline-lock';
import { setPendingRelease, getPendingRelease } from '@/lib/pipeline/pending-release';
import { jobsCache } from '@/lib/jobs/storage';

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
    CREATE TABLE IF NOT EXISTS pipeline_lock_events (
      id serial PRIMARY KEY,
      project text NOT NULL,
      released_by_job_id text,
      reason text NOT NULL,
      emitted_at double precision NOT NULL,
      consumed_by text,
      consumed_at double precision
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
      release_deadline_at integer,
      prompt_bytes integer,
      work_summary text,
      modified_files text,
      lines_added integer,
      lines_removed integer,
      provider text,
      run_score integer
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
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
}

describe('pipeline-lock', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestPgDbEmpty();
    await applyDdl(handle);
    mocks.dbRef.current = handle.db;
  });

  afterAll(async () => {
    try {
      await handle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await handle.db.execute(sql.raw(
      'TRUNCATE pipeline_locks, jobs, settings, projects',
    ));
    await handle.db.execute(sql.raw('TRUNCATE pipeline_lock_events RESTART IDENTITY'));
    jobsCache.clear();
    mocks.drainProjectRecoveryWork.mockReset().mockResolvedValue(undefined);
    mocks.drainNextAgentRun.mockReset().mockResolvedValue(undefined);
    mocks.legacyInlineDrainEnabled = true;
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
    // Populate the cache so getJob() can find the row.
    jobsCache.set(id, {
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

    it('self-heal emits an event but skips inline drain when the legacy flag is disabled', async () => {
      mocks.legacyInlineDrainEnabled = false;
      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);

      expect(await getLock('proj')).toBeNull();
      await vi.waitFor(async () => {
        const rows = await handle.db.select().from(schema.pipelineLockEvents);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          project: 'proj',
          releasedByJobId: 'old-release',
          reason: 'heal:holder_finished',
        });
      }, { interval: 1 });
      await new Promise<void>((r) => setImmediate(r));
      expect(mocks.drainProjectRecoveryWork).not.toHaveBeenCalled();
    });

    it('self-heal keeps a pending release queued when the drain is pause-blocked', async () => {
      mocks.drainProjectRecoveryWork.mockResolvedValue(undefined);

      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);
      setPendingRelease('proj');

      expect((await getLock('proj'))).toBeNull();
      await vi.waitFor(async () => expect(await getPendingRelease('proj')).toBe(true), { interval: 1 });
    });

    it('self-heal keeps a pending release queued when the drain throws', async () => {
      mocks.drainProjectRecoveryWork.mockRejectedValue(new Error('spawn failed'));

      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);
      setPendingRelease('proj');

      expect((await getLock('proj'))).toBeNull();
      await vi.waitFor(async () => expect(await getPendingRelease('proj')).toBe(true), { interval: 1 });
    });

    it('self-heal keeps a pending release queued on retryable startup failure', async () => {
      mocks.drainProjectRecoveryWork.mockResolvedValue(undefined);

      await insertLock('proj', 'old-release', Date.now() / 1000 - 5);
      await insertJob('old-release', 'proj', 'release', Date.now() / 1000 - 200, Date.now() / 1000 - 10);
      setPendingRelease('proj');

      expect((await getLock('proj'))).toBeNull();
      await vi.waitFor(async () => expect(await getPendingRelease('proj')).toBe(true), { interval: 1 });
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
      await vi.waitFor(async () => expect(await getLock('proj')).toBeNull(), { interval: 1 });
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
      await vi.waitFor(async () => expect(await getLock('proj-a')).toBeNull(), { interval: 1 });
      expect((await getLock('proj-b'))).not.toBeNull();
    });

    it('calls the ordered recovery drain for the project when the lock is released', async () => {
      await acquireLock('proj', 'job-drain');
      await releaseLock('proj', 'job-drain');
      await vi.waitFor(
        () => expect(mocks.drainProjectRecoveryWork).toHaveBeenCalledWith('proj', '[pipeline-lock]'),
        { interval: 1 },
      );
    });

    it('emits an event but skips inline drain when the legacy flag is disabled', async () => {
      mocks.legacyInlineDrainEnabled = false;
      await acquireLock('proj', 'job-drain');
      await releaseLock('proj', 'job-drain');

      await vi.waitFor(async () => {
        const rows = await handle.db.select().from(schema.pipelineLockEvents);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          project: 'proj',
          releasedByJobId: 'job-drain',
          reason: 'released',
        });
      }, { interval: 1 });
      await new Promise<void>((r) => setImmediate(r));
      expect(mocks.drainProjectRecoveryWork).not.toHaveBeenCalled();
    });

    it('does not call the recovery drain when the wrong job tries to release', async () => {
      await acquireLock('proj', 'job-owner');
      await releaseLock('proj', 'job-other');
      // Brief tick to let any (incorrect) fire-and-forget drain settle.
      await new Promise<void>((r) => setImmediate(r));
      expect(mocks.drainProjectRecoveryWork).not.toHaveBeenCalled();
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
      }, { interval: 1 });
    });

    it('overwrites an existing lock regardless of current holder', async () => {
      await acquireLock('proj', 'placeholder-id');
      await insertJob('placeholder-id', 'proj', 'release', Date.now() / 1000, null);
      reassignLock('proj', 'real-job-id');
      await vi.waitFor(async () => {
        const lock = await getLock('proj');
        expect(lock!.lockedByJobId).toBe('real-job-id');
      }, { interval: 1 });
    });

    it('updates acquiredAt to current time', async () => {
      const before = Date.now() / 1000;
      reassignLock('proj', 'job-1');
      await vi.waitFor(async () => {
        const lock = await getLock('proj');
        expect(lock).not.toBeNull();
        expect(lock!.acquiredAt).toBeGreaterThanOrEqual(before);
      }, { interval: 1 });
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
      }, { interval: 1 });
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
      }, { interval: 1 });
    });
  });
});
