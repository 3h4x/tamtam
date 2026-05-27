import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      prompt text,
      pid integer NOT NULL,
      log_path text,
      started_at double precision NOT NULL,
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
      provider text
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id text PRIMARY KEY,
      project text NOT NULL,
      source_kind text NOT NULL,
      source_id text,
      agent_id text,
      agent_name text,
      type text NOT NULL,
      title text NOT NULL,
      detail text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      payload text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS job_completion_events (
      id serial PRIMARY KEY,
      job_id text NOT NULL UNIQUE,
      kind text NOT NULL,
      exit_code integer,
      project text NOT NULL,
      release_id text,
      gh_issue_number integer,
      emitted_at double precision NOT NULL,
      consumed_by text,
      consumed_at double precision
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project text PRIMARY KEY,
      repo text NOT NULL,
      prs text NOT NULL DEFAULT '[]',
      issues text NOT NULL DEFAULT '[]',
      fetched_at double precision NOT NULL
    )
  `));
}

let sharedHandle: TestDbHandle;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
});

afterAll(async () => {
  // Drain any straggling fire-and-forget queries via a no-op SELECT before
  // closing. PGlite serializes queries on a single instance, so awaiting a
  // SELECT 1 flushes anything queued ahead of it without a fixed sleep.
  try {
    await sharedHandle.db.execute(sql.raw('SELECT 1'));
  } catch {
    // ignore
  }
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

async function truncateAll(): Promise<void> {
  // DELETE is faster than TRUNCATE on PGlite for small tables (no table rewrite,
  // no extension reload). Single execute() with multi-statement is rejected by
  // PGlite, so issue them via a single CTE-style query.
  await sharedHandle.db.execute(sql.raw(
    'WITH a AS (DELETE FROM jobs RETURNING 1), b AS (DELETE FROM recommendations RETURNING 1), c AS (DELETE FROM job_completion_events RETURNING 1) DELETE FROM gh_issues_cache'
  ));
}

async function yieldToNextTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// Getter shim so existing `testDb.db.*` test code keeps working while the
// underlying connection is the shared PGlite handle.
const testDb = {
  get db() {
    return sharedHandle.db;
  },
} as { db: TestDbHandle['db'] };

// `getJob`/`listJobs` are cache-only since commit 1cc1db25 — tests that seed
// rows via direct DB inserts must populate the in-memory cache too, or
// lifecycle hooks (which call `getJob`/`findActiveReleaseJob`/`listJobs`)
// won't see those rows. Call this after raw inserts and before invoking
// `markDoneFn`/lifecycle code so the cache mirrors the DB.
async function syncCacheFromDb(): Promise<void> {
  const { jobsCache } = await import('@/lib/jobs/storage');
  jobsCache.clear();
  const rows = await sharedHandle.db.select().from(schema.jobs);
  for (const row of rows) {
    jobsCache.set(row.id, {
      id: row.id,
      project: row.project,
      kind: row.kind,
      prompt: row.prompt ?? null,
      pid: row.pid,
      logPath: row.logPath,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? null,
      exitCode: row.exitCode ?? null,
      seen: row.seen ?? false,
      durationMs: row.durationMs ?? null,
      inputTokens: row.inputTokens ?? null,
      outputTokens: row.outputTokens ?? null,
      cacheReadTokens: row.cacheReadTokens ?? null,
      cacheCreateTokens: row.cacheCreateTokens ?? null,
      sessionId: row.sessionId ?? null,
      contextMeta: row.contextMeta ?? null,
      userPrompt: row.userPrompt ?? null,
      parentJobId: row.parentJobId ?? null,
      ghIssueNumber: row.ghIssueNumber ?? null,
      ghIssueRepo: row.ghIssueRepo ?? null,
      ghIssueTitle: row.ghIssueTitle ?? null,
      logPruned: row.logPruned ?? false,
      verdict: row.verdict ?? null,
      costUsd: row.costUsd ?? null,
      model: row.model ?? null,
      releaseId: row.releaseId ?? null,
      abortedAt: row.abortedAt ?? null,
      promptBytes: row.promptBytes ?? null,
      workSummary: row.workSummary ?? null,
      modifiedFiles: row.modifiedFiles ?? null,
      provider: row.provider ?? null,
    });
  }
}
describe('job-storage', () => {
  let tempDir: string;
  let createJob: typeof import('@/lib/jobs/job-storage').createJob;
  let getJob: typeof import('@/lib/jobs/job-storage').getJob;
  let listJobs: typeof import('@/lib/jobs/job-storage').listJobs;
  let markSeen: typeof import('@/lib/jobs/job-storage').markSeen;
  let markAllUnseenFinished: typeof import('@/lib/jobs/job-storage').markAllUnseenFinished;
  let unseenFinished: typeof import('@/lib/jobs/job-storage').unseenFinished;
  let updateJob: typeof import('@/lib/jobs/job-storage').updateJob;
  let readLog: typeof import('@/lib/jobs/job-storage').readLog;
  let getVerdict: typeof import('@/lib/jobs/job-storage').getVerdict;
  let jobToDict: typeof import('@/lib/jobs/job-storage').jobToDict;
  let jobToListDict: typeof import('@/lib/jobs/job-storage').jobToListDict;
  let probeJobStatus: typeof import('@/lib/jobs/job-storage').probeJobStatus;
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
    readLog = jobStorage.readLog;
    getVerdict = jobStorage.getVerdict;
    jobToDict = jobStorage.jobToDict;
    jobToListDict = jobStorage.jobToListDict;
    probeJobStatus = jobStorage.probeJobStatus;
    runWithParent = jobStorage.runWithParent;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-job-test-'));
    // Reset both the in-memory cache (module-level state shared across all
    // tests since we no longer reset modules) and the shared PGlite tables.
    storageCache.clear();
    await truncateAll();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  describe('readLog', () => {
    it('returns empty string if log path is null', () => {
      const job: JobData = {
        id: 'test-1',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath: null,
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(readLog(job)).toBe('');
    });

    it('returns empty string if log file does not exist', () => {
      const job: JobData = {
        id: 'test-2',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath: '/nonexistent/path/log.txt',
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(readLog(job)).toBe('');
    });

    it('reads full log if smaller than tailBytes', () => {
      const logFile = join(tempDir, 'test.log');
      const content = 'Line 1\nLine 2\nLine 3\n';
      writeFileSync(logFile, content);

      const job: JobData = {
        id: 'test-3',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(readLog(job)).toBe(content);
    });

    it('reads tail of log if larger than tailBytes', () => {
      const logFile = join(tempDir, 'large.log');
      const prefix = 'x'.repeat(200000);
      const suffix = '\nTail content';
      writeFileSync(logFile, prefix + suffix);

      const job: JobData = {
        id: 'test-4',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const result = readLog(job, 100000);
      expect(result).toContain('Tail content');
      expect(result.length).toBeLessThanOrEqual(100000);
    });

    it('trims to newline boundary when reading tail', () => {
      const logFile = join(tempDir, 'partial.log');
      const content = 'Line 1\nLine 2\nLine 3\n';
      writeFileSync(logFile, content);

      const job: JobData = {
        id: 'test-5',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      // Read with small tailBytes to test boundary trimming
      const result = readLog(job, 10);
      // Should read from first newline boundary in the tail
      expect(result).toBe('Line 3\n');
    });
  });

  describe('getVerdict', () => {
    it('returns null if job is still running', () => {
      const job: JobData = {
        id: 'test-6',
        project: 'proj',
        kind: 'review',
        prompt: null,
        pid: 123,
        logPath: null,
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBeNull();
    });

    it('returns null if job kind is not review', () => {
      const job: JobData = {
        id: 'test-7',
        project: 'proj',
        kind: 'test',
        prompt: null,
        pid: 123,
        logPath: null,
        startedAt: Date.now() / 1000,
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBeNull();
    });

    it('extracts verdict from log', () => {
      const logFile = join(tempDir, 'review.log');
      writeFileSync(logFile, 'Some output\nVerdict: LGTM\nMore output\n');

      const job: JobData = {
        id: 'test-8',
        project: 'proj',
        kind: 'review',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBe('LGTM');
    });

    it('extracts NEEDS ATTENTION verdict', () => {
      const logFile = join(tempDir, 'review2.log');
      writeFileSync(logFile, 'Verdict: NEEDS ATTENTION');

      const job: JobData = {
        id: 'test-9',
        project: 'proj',
        kind: 'review',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBe('NEEDS ATTENTION');
    });

    it('extracts DO NOT SHIP verdict', () => {
      const logFile = join(tempDir, 'review3.log');
      writeFileSync(logFile, 'Final verdict: DO NOT SHIP');

      const job: JobData = {
        id: 'test-10',
        project: 'proj',
        kind: 'review',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBe('DO NOT SHIP');
    });

    it('returns null if verdict not found in log', () => {
      const logFile = join(tempDir, 'no-verdict.log');
      writeFileSync(logFile, 'Just some output\nNo verdict here');

      const job: JobData = {
        id: 'test-11',
        project: 'proj',
        kind: 'review',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBeNull();
    });

    it('does not classify prose containing "not LGTM" as LGTM', () => {
      const logFile = join(tempDir, 'not-lgtm.log');
      writeFileSync(logFile, 'This is not LGTM because there are issues.\nSee above.\n');

      const job: JobData = {
        id: 'test-12',
        project: 'proj',
        kind: 'review',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBeNull();
    });

    it('accepts a token when it stands alone on the final line', () => {
      const logFile = join(tempDir, 'final-line.log');
      writeFileSync(logFile, 'Review follows...\nIssues: none.\n\nLGTM\n');

      const job: JobData = {
        id: 'test-13',
        project: 'proj',
        kind: 'review',
        prompt: null,
        pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000,
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      expect(getVerdict(job)).toBe('LGTM');
    });

    // Real-world verdict formats Claude emits — each regression here came
    // from a concrete release where we silently fell back to "unknown".
    function reviewJob(id: string, logContent: string, tempDir: string): JobData {
      const logFile = join(tempDir, `${id}.log`);
      writeFileSync(logFile, logContent);
      return {
        id, project: 'proj', kind: 'review', prompt: null, pid: 123,
        logPath: logFile,
        startedAt: Date.now() / 1000, finishedAt: Date.now() / 1000,
        exitCode: 0, seen: false, durationMs: null,
        inputTokens: null, outputTokens: null, cacheReadTokens: null,
        cacheCreateTokens: null, sessionId: null,
      };
    }

    it('matches "LGTM — one-line rationale" (em-dash) as LGTM', () => {
      const job = reviewJob('verdict-emdash', [
        'Review complete.',
        'All tests pass, no obvious issues.',
        'LGTM — adds configurable engine tuning knobs (seed count, similar toggle), wires them through ConfigPanel with a UI refactor, and backs it with solid test coverage.',
      ].join('\n'), tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('matches "LGTM - one-line rationale" (ASCII hyphen) as LGTM', () => {
      const job = reviewJob('verdict-hyphen', 'LGTM - clean change, covered by tests.', tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('matches "LGTM – one-line rationale" (en-dash) as LGTM', () => {
      const job = reviewJob('verdict-endash', 'LGTM – no concerns.', tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('matches "LGTM: rationale" (colon) as LGTM', () => {
      const job = reviewJob('verdict-colon', 'LGTM: tests cover the new branches.', tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('matches "**LGTM** — rationale" (bold markdown) as LGTM', () => {
      const job = reviewJob('verdict-bold', '**LGTM** — refactor is clean.', tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('matches "NEEDS ATTENTION — rationale" as NEEDS ATTENTION', () => {
      const job = reviewJob('verdict-na', 'NEEDS ATTENTION — missing error handling in push.ts.', tempDir);
      expect(getVerdict(job)).toBe('NEEDS ATTENTION');
    });

    it('matches "DO NOT SHIP — reason" as DO NOT SHIP', () => {
      const job = reviewJob('verdict-dns', 'DO NOT SHIP — regressions in test suite.', tempDir);
      expect(getVerdict(job)).toBe('DO NOT SHIP');
    });

    it('rejects the prompt enumeration line "LGTM / NEEDS ATTENTION / DO NOT SHIP"', () => {
      const job = reviewJob('verdict-enum', 'Pick one: LGTM / NEEDS ATTENTION / DO NOT SHIP', tempDir);
      expect(getVerdict(job)).toBeNull();
    });

    it('returns the last verdict when multiple appear (final decision wins)', () => {
      const job = reviewJob('verdict-last', [
        'Initially thought NEEDS ATTENTION but reconsidered.',
        '',
        'LGTM — issue is cosmetic.',
      ].join('\n'), tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('picks verdict from any of the last few non-empty lines (tolerates trailing metadata)', () => {
      const job = reviewJob('verdict-near-end', [
        'LGTM — looks great.',
        '',
        '(review duration: 1m 12s)',
      ].join('\n'), tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('does not match verdict when review job has not finished', () => {
      const job = reviewJob('verdict-running', 'LGTM — done.', tempDir);
      job.finishedAt = null; // still running
      expect(getVerdict(job)).toBeNull();
    });

    it('does not match verdict for non-review job kinds', () => {
      const job = reviewJob('verdict-wrong-kind', 'LGTM — done.', tempDir);
      job.kind = 'test';
      expect(getVerdict(job)).toBeNull();
    });

    // Regressions from real production review outputs. Each case is a log
    // shape that previously slipped through with `null` (→ UI shows unknown
    // ✗ even though Claude clearly signaled LGTM).
    it('detects LGTM when followed by a long rationale across multiple lines', () => {
      const job = reviewJob('verdict-long-rationale', [
        '## Summary',
        '',
        'All tests pass, the refactor is straightforward and well-covered.',
        '',
        'LGTM — adds configurable engine tuning knobs, wires them through ConfigPanel with a UI refactor, and backs it with solid test coverage. One non-blocking note: the actor engine threshold loosened previously required count>=3 && count>=2 && more actor groups at default settings — looks intentional given the new tunable.',
      ].join('\n'), tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });

    it('returns null when the review body has no verdict at all (report-only)', () => {
      // This mirrors the real case where Claude summarized its fix actions
      // but never emitted LGTM/NEEDS ATTENTION/DO NOT SHIP. We want null
      // (→ UI surfaces "unknown") rather than a false positive.
      const job = reviewJob('verdict-report-only', [
        '## Summary',
        '',
        'Root cause: Release meta-jobs were created with process.pid. When the server restarts, probeJobStatus detected the old PID dead and marked the job with exit_code=-1 — causing the red X in Last Run.',
        '',
        'Three fixes made:',
        '',
        '1. lib/job-storage.ts — probeJobStatus: Release jobs now check pid === process.pid.',
        '2. lib/job-storage.ts — runCompletionHooks: A successful push now always finalizes the active release meta-job.',
        '3. components/ProjectDetailPage.tsx: Changed lastFailed check from exit_code > 0 to exit_code !== 0.',
        '',
        'Both new tests pass. Let me mark the last task done.',
      ].join('\n'), tempDir);
      expect(getVerdict(job)).toBeNull();
    });

    it('does not match "LGTM!" variants embedded in prose without a separator', () => {
      // "...the refactor LGTM overall" — no line-start token, no separator;
      // must NOT be treated as a verdict or we get false positives from
      // reviewers who use the term descriptively.
      const job = reviewJob('verdict-inline', 'Honestly the refactor LGTM overall, but we should split it.', tempDir);
      expect(getVerdict(job)).toBeNull();
    });

    it('prefers "Verdict: X" header over a later unrelated token mention', () => {
      const job = reviewJob('verdict-header-wins', [
        'Verdict: LGTM',
        '',
        'Some extra notes: we should consider whether DO NOT SHIP rules apply to docs-only changes.',
      ].join('\n'), tempDir);
      expect(getVerdict(job)).toBe('LGTM');
    });
  });

  describe('jobToDict', () => {
    it('converts running job to dict', () => {
      const job: JobData = {
        id: 'job-123',
        project: 'proj-a',
        kind: 'review',
        prompt: null,
        pid: 5678,
        logPath: '/path/to/log',
        startedAt: 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const dict = jobToDict(job);
      expect(dict).toMatchObject({
        id: 'job-123',
        project: 'proj-a',
        kind: 'review',
        prompt: null,
        pid: 5678,
        log_path: '/path/to/log',
        status: 'running',
        exit_code: null,
        started_at: 1000,
        finished_at: null,
        seen: false,
      });
      expect(dict).toHaveProperty('duration_ms');
      expect(dict).toHaveProperty('input_tokens');
      expect(dict).toHaveProperty('session_id');
    });

    it('converts finished job to dict', () => {
      const job: JobData = {
        id: 'job-456',
        project: 'proj-b',
        kind: 'test',
        prompt: null,
        pid: 9999,
        logPath: '/path/to/log2',
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 0,
        seen: true,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const dict = jobToDict(job);
      expect(dict.status).toBe('done');
      expect(dict.exit_code).toBe(0);
      expect(dict.finished_at).toBe(2000);
      expect(dict.seen).toBe(true);
    });

    it('includes verdict in dict if present', () => {
      const logFile = join(tempDir, 'verdict.log');
      writeFileSync(logFile, 'Verdict: LGTM');

      const job: JobData = {
        id: 'job-789',
        project: 'proj-c',
        kind: 'review',
        prompt: null,
        pid: 1111,
        logPath: logFile,
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const dict = jobToDict(job);
      expect(dict.verdict).toBe('LGTM');
    });
  });

  describe('jobToListDict', () => {
    it('omits log path and truncates prompt payloads for list responses', () => {
      const prompt = 'p'.repeat(250);
      const userPrompt = 'u'.repeat(250);
      const job: JobData = {
        id: 'job-list',
        project: 'proj-list',
        kind: 'run',
        prompt,
        pid: 1234,
        logPath: '/path/to/large.log',
        startedAt: 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        userPrompt,
      };

      const dict = jobToListDict(job);

      expect(dict.id).toBe('job-list');
      expect(dict).not.toHaveProperty('log_path');
      expect(dict.prompt).toHaveLength(200);
      expect(dict.user_prompt).toHaveLength(200);
    });

    it('preserves null prompt fields for list responses', () => {
      const job: JobData = {
        id: 'job-list-null',
        project: 'proj-list',
        kind: 'run',
        prompt: null,
        pid: 1234,
        logPath: null,
        startedAt: 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        userPrompt: null,
      };

      const dict = jobToListDict(job);

      expect(dict.prompt).toBeNull();
      expect(dict.user_prompt).toBeNull();
    });
  });

  describe('probeJobStatus', () => {
    it('returns done if job has finishedAt', async () => {
      const job: JobData = {
        id: 'job-done',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath: null,
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const status = await probeJobStatus(job);
      expect(status).toBe('done');
    });

    it('marks job as done if pid is invalid', async () => {
      const job: JobData = {
        id: 'job-bad-pid',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: -1,
        logPath: null,
        // Past the spawn-grace window so pid<=0 is treated as dead, not
        // still-spawning. A freshly-created pid=0 job (ageSec < 30) is
        // covered by the spawn-grace tests in `probeJobStatus`.
        startedAt: Date.now() / 1000 - 60,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const status = await probeJobStatus(job);
      expect(status).toBe('done');
      expect(job.finishedAt).not.toBeNull();
      expect(job.exitCode).toBe(-1);
    });

  });
});
describe('readParsedLog', () => {
  let tempDir: string;
  let readParsedLog: typeof import('@/lib/jobs/job-storage').readParsedLog;

  // `readParsedLog` is a pure file-reading function with no DB writes or
  // completion-hook side effects. Hoisting the import lets the 8 tests in
  // this describe share a single module-load instead of paying it per test.
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/jobs/job-storage');
    readParsedLog = mod.readParsedLog;
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-parsed-log-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/project-data');
    vi.resetModules();
  });

  function makeJob(overrides: Partial<JobData> = {}): JobData {
    return {
      id: 'parsed-test',
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 123,
      logPath: null,
      startedAt: 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      ...overrides,
    };
  }

  it('returns empty string when job has no log path', () => {
    const job = makeJob({ logPath: null });
    expect(readParsedLog(job)).toBe('');
  });

  it('returns empty string when log file does not exist', () => {
    const job = makeJob({ logPath: '/nonexistent/file.log' });
    expect(readParsedLog(job)).toBe('');
  });

  it('returns raw log content when no stream events present', () => {
    const logFile = join(tempDir, 'raw.log');
    const content = 'plain text output\nno json here\n';
    writeFileSync(logFile, content);
    const job = makeJob({ logPath: logFile });
    expect(readParsedLog(job)).toBe(content);
  });

  it('extracts text from stream events', () => {
    const logFile = join(tempDir, 'stream.log');
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}}';
    writeFileSync(logFile, line + '\n');
    const job = makeJob({ logPath: logFile });
    expect(readParsedLog(job)).toBe('Hello world');
  });

  it('does not append completion marker inline (stored in DB instead)', () => {
    const logFile = join(tempDir, 'done.log');
    const textLine = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Output"}}}';
    const doneLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":1500,"total_cost_usd":0.01,"session_id":"s1","result":"Output"}';
    writeFileSync(logFile, textLine + '\n' + doneLine + '\n');
    const job = makeJob({ logPath: logFile });
    const result = readParsedLog(job);
    expect(result).toBe('Output');
    expect(result).not.toContain('Completed');
  });

  it('surfaces result error text when no assistant text was emitted', () => {
    const logFile = join(tempDir, 'error-result.log');
    const doneLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":1500,"session_id":"s1","result":"[codex-shim] codex produced no assistant output"}';
    writeFileSync(logFile, doneLine + '\n');
    const job = makeJob({ logPath: logFile });
    expect(readParsedLog(job)).toBe('[codex-shim] codex produced no assistant output');
  });

  it('concatenates multiple text events', () => {
    const logFile = join(tempDir, 'multi.log');
    const line1 = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}}';
    const line2 = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}}';
    writeFileSync(logFile, line1 + '\n' + line2 + '\n');
    const job = makeJob({ logPath: logFile });
    expect(readParsedLog(job)).toBe('Hello world');
  });

  it('falls back to raw log when no extractable text events', () => {
    const logFile = join(tempDir, 'no-text.log');
    const systemLine = '{"type":"system","subtype":"init","session_id":"x"}';
    writeFileSync(logFile, systemLine + '\n');
    const job = makeJob({ logPath: logFile });
    // system events produce no text, so raw log is returned
    expect(readParsedLog(job)).toBe(systemLine + '\n');
  });
});
