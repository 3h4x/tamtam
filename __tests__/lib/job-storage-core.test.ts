import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/job-storage';
import {
  applyJobStorageDdl,
  createTestDbShim,
  createTestPgDbEmpty,
  drainJobStorageDb,
  truncateJobStorageTables,
  yieldToNextTask,
  type TestDbHandle,
} from './job-storage-core-fixtures';

let sharedHandle: TestDbHandle;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyJobStorageDdl(sharedHandle);
});

afterAll(async () => {
  await drainJobStorageDb(sharedHandle);
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

async function truncateAll(): Promise<void> {
  await truncateJobStorageTables(sharedHandle);
}

// Getter shim so existing `testDb.db.*` test code keeps working while the
// underlying connection is the shared PGlite handle.
const testDb = createTestDbShim(() => sharedHandle);
describe('job-storage', () => {
  let createJob: typeof import('@/lib/jobs/job-storage').createJob;
  let getJob: typeof import('@/lib/jobs/job-storage').getJob;
  let listJobs: typeof import('@/lib/jobs/job-storage').listJobs;
  let markSeen: typeof import('@/lib/jobs/job-storage').markSeen;
  let markAllUnseenFinished: typeof import('@/lib/jobs/job-storage').markAllUnseenFinished;
  let unseenFinished: typeof import('@/lib/jobs/job-storage').unseenFinished;
  let updateJob: typeof import('@/lib/jobs/job-storage').updateJob;
  let awaitInFlightSave: typeof import('@/lib/jobs/storage').awaitInFlightSave;
  let runWithParent: typeof import('@/lib/jobs/job-storage').runWithParent;
  let storageCache: Map<string, JobData>;

  // All tests in this describe share the same mock setup, so install mocks
  // and import the module once. Per-test isolation is achieved by clearing
  // `jobsCache` and TRUNCATEing the shared PGlite tables in `beforeEach`.
  // This avoids paying the ~5-15ms `vi.resetModules() + await import(...)`
  // re-execution cost on every test.
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      db: sharedHandle.db,
      schema,
    }));
    const jobStorage = await import('@/lib/jobs/job-storage');
    createJob = jobStorage.createJob;
    getJob = jobStorage.getJob;
    listJobs = jobStorage.listJobs;
    markSeen = jobStorage.markSeen;
    markAllUnseenFinished = jobStorage.markAllUnseenFinished;
    unseenFinished = jobStorage.unseenFinished;
    updateJob = jobStorage.updateJob;
    runWithParent = jobStorage.runWithParent;
    const storage = await import('@/lib/jobs/storage');
    awaitInFlightSave = storage.awaitInFlightSave;
    storageCache = storage.jobsCache;
  });

  beforeEach(async () => {
    // Reset both the in-memory cache (module-level state shared across all
    // tests since we no longer reset modules) and the shared PGlite tables.
    storageCache.clear();
    await truncateAll();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.resetModules();
  });

  describe('createJob', () => {
    it('creates a job with unique ID', () => {
      const job1 = createJob('project-a', 'review', 1234, '/path/to/log1');
      const job2 = createJob('project-a', 'review', 5678, '/path/to/log2');

      expect(job1.id).not.toBe(job2.id);
      expect(job1.project).toBe('project-a');
      expect(job1.kind).toBe('review');
      expect(job1.pid).toBe(1234);
      expect(job1.logPath).toBe('/path/to/log1');
      expect(job1.finishedAt).toBeNull();
      expect(job1.exitCode).toBeNull();
      expect(job1.seen).toBe(false);
    });

    it('generates job IDs in format project-kind-timestamp', () => {
      const job = createJob('myproj', 'test', 999, '/log');
      expect(job.id).toMatch(/^myproj-test-\d+$/);
    });

    it('stores job in cache and database', () => {
      const job = createJob('proj', 'run', 555, '/log');
      const retrieved = getJob(job.id);
      expect(retrieved).toEqual(job);
    });

    it('persists run skill attribution on the jobs row', async () => {
      const job = createJob('proj', 'agent:runner', 555, '/log');
      job.skillIds = JSON.stringify([{ id: 'skill-a', name: 'Skill A', promptChars: 120, source: 'db' }]);
      updateJob(job);
      await awaitInFlightSave(job.id);

      const rows = await testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
      expect(rows[0]?.skillIds).toBe(job.skillIds);
    });

    it('creates job with prompt when provided', () => {
      const job = createJob('proj', 'run', 123, '/log', 'my task prompt');
      expect(job.prompt).toBe('my task prompt');
    });

    it('creates job with null prompt when not provided', () => {
      const job = createJob('proj', 'run', 123, '/log');
      expect(job.prompt).toBeNull();
    });

    it('stores ghIssueNumber, ghIssueRepo, ghIssueTitle when provided', () => {
      const job = createJob('proj', 'run', 123, '/log', 'prompt', undefined, undefined, 42, 'owner/repo', 'Fix login bug');
      expect(job.ghIssueNumber).toBe(42);
      expect(job.ghIssueRepo).toBe('owner/repo');
      expect(job.ghIssueTitle).toBe('Fix login bug');
    });

    it('persists ghIssueNumber to db so getJob returns it', () => {
      const job = createJob('proj', 'run', 123, '/log', undefined, undefined, undefined, 7, 'org/proj', 'Issue title');
      const retrieved = getJob(job.id);
      expect(retrieved?.ghIssueNumber).toBe(7);
      expect(retrieved?.ghIssueRepo).toBe('org/proj');
      expect(retrieved?.ghIssueTitle).toBe('Issue title');
    });

    it('defaults ghIssue fields to null when not provided', () => {
      const job = createJob('proj', 'run', 123, '/log');
      expect(job.ghIssueNumber).toBeNull();
      expect(job.ghIssueRepo).toBeNull();
      expect(job.ghIssueTitle).toBeNull();
    });

    it('defaults parentJobId to null when no context and no explicit param', () => {
      const job = createJob('proj', 'review', 1, '/log');
      expect(job.parentJobId).toBeNull();
    });

    it('picks up parentJobId from runWithParent context', async () => {
      let childJob: ReturnType<typeof createJob> | null = null;
      await runWithParent('parent-job-123', async () => {
        childJob = createJob('proj', 'fix', 2, '/log');
      });
      expect(childJob!.parentJobId).toBe('parent-job-123');
    });

    it('explicit parentJobId param takes precedence over runWithParent context', async () => {
      let childJob: ReturnType<typeof createJob> | null = null;
      await runWithParent('ctx-parent', async () => {
        childJob = createJob('proj', 'commit', 3, '/log', undefined, undefined, undefined, null, null, null, 'explicit-parent');
      });
      expect(childJob!.parentJobId).toBe('explicit-parent');
    });

    it('context does not leak outside runWithParent call', async () => {
      await runWithParent('leak-test-parent', async () => {
        createJob('proj', 'test', 4, '/log');
      });
      const outsideJob = createJob('proj', 'review', 5, '/log');
      expect(outsideJob.parentJobId).toBeNull();
    });

    it('concurrent runWithParent contexts do not cross-contaminate', async () => {
      const results: Array<{ id: string; parentJobId: string | null | undefined }> = [];
      await Promise.all([
        runWithParent('parent-A', async () => {
          await yieldToNextTask();
          const job = createJob('proj', 'fix', 10, '/log');
          results.push({ id: job.id, parentJobId: job.parentJobId });
        }),
        runWithParent('parent-B', async () => {
          const job = createJob('proj', 'fix', 11, '/log');
          results.push({ id: job.id, parentJobId: job.parentJobId });
        }),
      ]);
      const jobA = results.find((r) => r.parentJobId === 'parent-A');
      const jobB = results.find((r) => r.parentJobId === 'parent-B');
      expect(jobA).toBeTruthy();
      expect(jobB).toBeTruthy();
    });

    it('auto-links releaseId when the job is started under the active release parent chain', async () => {
      const releaseJob = createJob('my-proj', 'release', 100, '/log-release');
      releaseJob.releaseId = releaseJob.id;
      updateJob(releaseJob);
      let reviewJob: ReturnType<typeof createJob> | null = null;
      await runWithParent(releaseJob.id, async () => {
        reviewJob = createJob('my-proj', 'review', 101, '/log-review');
      });
      expect(reviewJob).not.toBeNull();
      expect(reviewJob!.parentJobId).toBe(releaseJob.id);
      expect(reviewJob!.releaseId).toBe(releaseJob.id);
    });

    it('does not auto-link a standalone job just because an active release exists', () => {
      const releaseJob = createJob('my-proj', 'release', 100, '/log-release');
      releaseJob.releaseId = releaseJob.id;
      updateJob(releaseJob);
      const reviewJob = createJob('my-proj', 'review', 101, '/log-review');
      expect(reviewJob.releaseId).toBeNull();
      expect(reviewJob.parentJobId).toBeNull();
    });

    it('does not auto-link releaseId when kind is release (no self-link)', () => {
      const release1 = createJob('my-proj', 'release', 100, '/log-1');
      const release2 = createJob('my-proj', 'release', 101, '/log-2');
      expect(release1.releaseId).toBeNull();
      expect(release2.releaseId).toBeNull();
    });

    it('does not auto-link releaseId when no active release exists', () => {
      const reviewJob = createJob('my-proj', 'review', 101, '/log-review');
      expect(reviewJob.releaseId).toBeNull();
    });

    it('does not auto-link to a release job from a different project', () => {
      createJob('other-proj', 'release', 100, '/log-release');
      const reviewJob = createJob('my-proj', 'review', 101, '/log-review');
      expect(reviewJob.releaseId).toBeNull();
    });

    it('does not auto-link to a finished release job', () => {
      const releaseJob = createJob('my-proj', 'release', 100, '/log-release');
      // Mutate the same reference held in the cache (matching how markDone works)
      releaseJob.finishedAt = Date.now() / 1000;
      releaseJob.exitCode = 0;
      const reviewJob = createJob('my-proj', 'review', 101, '/log-review');
      expect(reviewJob.releaseId).toBeNull();
    });
  });

  describe('getJob', () => {
    it('retrieves job from cache', () => {
      const job = createJob('proj', 'kind', 123, '/log');
      const retrieved = getJob(job.id);
      expect(retrieved).toEqual(job);
    });

    it('returns null for nonexistent job', () => {
      const job = getJob('nonexistent-id');
      expect(job).toBeNull();
    });

    it('retrieves job by id from database', () => {
      const job = createJob('proj', 'kind', 123, '/log');
      const retrieved = getJob(job.id);
      expect(retrieved?.id).toBe(job.id);
      expect(retrieved?.project).toBe('proj');
      expect(retrieved?.kind).toBe('kind');
      expect(retrieved?.pid).toBe(123);
    });
  });

  describe('listJobs', () => {
    it('returns empty list initially', () => {
      const jobs = listJobs();
      expect(jobs).toEqual([]);
    });

    it('lists all created jobs', () => {
      const job1 = createJob('proj1', 'review', 111, '/log1');
      const job2 = createJob('proj2', 'test', 222, '/log2');
      const job3 = createJob('proj1', 'run', 333, '/log3');

      const jobs = listJobs();
      expect(jobs).toHaveLength(3);
      expect(jobs.map((j) => j.id)).toContain(job1.id);
      expect(jobs.map((j) => j.id)).toContain(job2.id);
      expect(jobs.map((j) => j.id)).toContain(job3.id);
    });
  });

  describe('markSeen', () => {
    it('marks job as seen', () => {
      const job = createJob('proj', 'kind', 123, '/log');
      expect(job.seen).toBe(false);

      markSeen(job.id);
      const updated = getJob(job.id);
      expect(updated?.seen).toBe(true);
    });

    it('returns true when job exists', () => {
      const job = createJob('proj', 'kind', 123, '/log');
      const result = markSeen(job.id);
      expect(result).toBe(true);
    });

    it('returns false for nonexistent job', () => {
      const result = markSeen('nonexistent-id');
      expect(result).toBe(false);
    });
  });

  describe('markAllUnseenFinished', () => {
    it('waits for stale in-flight saves before the bulk seen update', async () => {
      const job = createJob('proj', 'review', 123, '/log');
      job.finishedAt = 1234567890;
      job.exitCode = 1;
      job.seen = false;

      // Simulate a completion save that captured seen=false before the user
      // cleared the notification badge. The bulk mark-all path must wait for
      // this stale write, then make its single UPDATE last.
      updateJob({ ...job });
      await yieldToNextTask();

      const marked = await markAllUnseenFinished();
      expect(marked).toBe(1);
      expect(getJob(job.id)?.seen).toBe(true);

      const rows = await testDb.db
        .select({ seen: schema.jobs.seen })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job.id));
      expect(rows[0]?.seen).toBe(true);
    });
  });

  describe('unseenFinished', () => {
    it('returns empty list initially', () => {
      const jobs = unseenFinished();
      expect(jobs).toEqual([]);
    });

    it('returns only unseen finished jobs', () => {
      const job1 = createJob('proj1', 'review', 111, '/log1');
      const job2 = createJob('proj2', 'test', 222, '/log2');
      const _job3 = createJob('proj3', 'run', 333, '/log3');

      // Mark job1 as finished and unseen
      job1.finishedAt = Date.now() / 1000;
      job1.exitCode = 0;
      updateJob(job1);

      // Mark job2 as finished and seen
      job2.finishedAt = Date.now() / 1000;
      job2.exitCode = 0;
      updateJob(job2);
      markSeen(job2.id);

      // job3 is running (no finishedAt)

      const unseen = unseenFinished();
      expect(unseen).toHaveLength(1);
      expect(unseen[0].id).toBe(job1.id);
    });
  });

  describe('updateJob', () => {
    it('updates job in cache and database', () => {
      const job = createJob('proj', 'kind', 123, '/log');

      job.exitCode = 42;
      job.finishedAt = 1234567890;
      updateJob(job);

      const retrieved = getJob(job.id);
      expect(retrieved?.exitCode).toBe(42);
      expect(retrieved?.finishedAt).toBe(1234567890);
    });

    it('persists release issue stamps added after createJob across a reload', async () => {
      const release = createJob('proj', 'release', 0, '/log');
      release.ghIssueNumber = 42;
      release.ghIssueRepo = 'owner/repo';
      release.ghIssueTitle = 'Fix login bug';
      release.releaseId = release.id;
      release.runScore = 95;
      updateJob(release);

      vi.resetModules();
      vi.doMock('@/lib/db', () => ({
        db: sharedHandle.db,
        schema,
      }));
      // Settle fire-and-forget saveToDb before reading from a fresh module.
      // PGlite serializes queries, so a SELECT 1 flushes the pending INSERT.
      await sharedHandle.db.execute(sql.raw('SELECT 1'));
      const reloaded = await import('@/lib/jobs/job-storage');
      // `getJob` is cache-only; hydrate the fresh module's cache from the DB
      // to simulate the production boot path that would call loadFromDb().
      await reloaded.loadFromDb();
      const persisted = reloaded.getJob(release.id);

      expect(persisted?.ghIssueNumber).toBe(42);
      expect(persisted?.ghIssueRepo).toBe('owner/repo');
      expect(persisted?.ghIssueTitle).toBe('Fix login bug');
      expect(persisted?.releaseId).toBe(release.id);
      expect(persisted?.runScore).toBe(95);
    });

    it('persists mark-dod issue stamps and context meta added after createJob across a reload', async () => {
      const dod = createJob('proj', 'mark-dod', 0, '/log');
      dod.ghIssueNumber = 7;
      dod.ghIssueRepo = 'owner/repo';
      dod.ghIssueTitle = 'Add login feature';
      dod.contextMeta = JSON.stringify({
        sourceType: 'issue',
        sourceNumber: 7,
        sourceRepo: 'owner/repo',
        sourceTitle: 'Add login feature',
        verified: 1,
        total: 2,
      });
      updateJob(dod);

      vi.resetModules();
      vi.doMock('@/lib/db', () => ({
        db: sharedHandle.db,
        schema,
      }));
      // Settle fire-and-forget saveToDb before reading from a fresh module.
      // PGlite serializes queries, so a SELECT 1 flushes the pending INSERT.
      await sharedHandle.db.execute(sql.raw('SELECT 1'));
      const reloaded = await import('@/lib/jobs/job-storage');
      // `getJob` is cache-only; hydrate the fresh module's cache from the DB.
      await reloaded.loadFromDb();
      const persisted = reloaded.getJob(dod.id);

      expect(persisted?.ghIssueNumber).toBe(7);
      expect(persisted?.ghIssueRepo).toBe('owner/repo');
      expect(persisted?.ghIssueTitle).toBe('Add login feature');
      expect(persisted?.contextMeta).toContain('"sourceType":"issue"');
      expect(persisted?.contextMeta).toContain('"sourceNumber":7');
    });
  });

});
