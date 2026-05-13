import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function createTestDb() {
  const dbPath = ':memory:';
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL,
      log_path TEXT,
      started_at REAL NOT NULL,
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
      release_deadline_at INTEGER,
      prompt_bytes INTEGER,
      work_summary TEXT,
      modified_files TEXT,
      provider TEXT
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      agent_id TEXT,
      agent_name TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      payload TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      prs TEXT NOT NULL DEFAULT '[]',
      issues TEXT NOT NULL DEFAULT '[]',
      fetched_at REAL NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('job-storage', () => {
  let tempDir: string;
  let testDb: ReturnType<typeof createTestDb>;
  let createJob: typeof import('@/lib/jobs/job-storage').createJob;
  let getJob: typeof import('@/lib/jobs/job-storage').getJob;
  let listJobs: typeof import('@/lib/jobs/job-storage').listJobs;
  let markSeen: typeof import('@/lib/jobs/job-storage').markSeen;
  let unseenFinished: typeof import('@/lib/jobs/job-storage').unseenFinished;
  let updateJob: typeof import('@/lib/jobs/job-storage').updateJob;
  let readLog: typeof import('@/lib/jobs/job-storage').readLog;
  let getVerdict: typeof import('@/lib/jobs/job-storage').getVerdict;
  let jobToDict: typeof import('@/lib/jobs/job-storage').jobToDict;
  let probeJobStatus: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  let runWithParent: typeof import('@/lib/jobs/job-storage').runWithParent;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-job-test-'));

    // Clear all mocks and modules
    vi.resetModules();

    // Create a fresh test database
    testDb = createTestDb();

    // Mock the db module
    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    // Now import job-storage (which will use the mocked db)
    const jobStorage = await import('@/lib/jobs/job-storage');
    createJob = jobStorage.createJob;
    getJob = jobStorage.getJob;
    listJobs = jobStorage.listJobs;
    markSeen = jobStorage.markSeen;
    unseenFinished = jobStorage.unseenFinished;
    updateJob = jobStorage.updateJob;
    readLog = jobStorage.readLog;
    getVerdict = jobStorage.getVerdict;
    jobToDict = jobStorage.jobToDict;
    probeJobStatus = jobStorage.probeJobStatus;
    runWithParent = jobStorage.runWithParent;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
          await new Promise((r) => setTimeout(r, 5));
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
        db: testDb.db,
        schema,
      }));
      const reloaded = await import('@/lib/jobs/job-storage');
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
        db: testDb.db,
        schema,
      }));
      const reloaded = await import('@/lib/jobs/job-storage');
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
        // covered by the spawn-grace tests in `probeJobStatus with pm2`.
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
  let testDb: ReturnType<typeof createTestDb>;
  let readParsedLog: typeof import('@/lib/jobs/job-storage').readParsedLog;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-parsed-log-test-'));
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ getJobStatus: vi.fn(), deleteJob: vi.fn() }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/jobs/job-storage');
    readParsedLog = mod.readParsedLog;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
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

describe('probeJobStatus with pm2', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  let getJobStatusMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    getJobStatusMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ getJobStatus: getJobStatusMock, getJobPid: vi.fn().mockResolvedValue(null), deleteJob: vi.fn() }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns running if pm2 reports running', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'running', exitCode: null });

    const job: JobData = {
      id: 'job-pm2-running',
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });

  it('marks done with exit code if pm2 reports done', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });

    const job: JobData = {
      id: 'job-pm2-done',
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.finishedAt).not.toBeNull();
    expect(job.exitCode).toBe(0);
  });

  it('marks done via process.kill when pid no longer exists', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });

    const job: JobData = {
      id: 'job-dead-pid',
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 2147483647, // extremely unlikely to exist
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    // Either running (if signal succeeds by chance) or done (pid dead) — both valid
    expect(['running', 'done']).toContain(status);
  });

  it('overrides exit code to 0 when log has a clean result (is_error:false) and pm2 reports non-zero', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: -1 });

    const logFile = join(tmpdir(), `tamtam-exitcode-override-${Date.now()}.log`);
    const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":500,"total_cost_usd":0,"session_id":"s1","result":"ok"}';
    writeFileSync(logFile, resultLine + '\n');

    const job: JobData = {
      id: 'job-override',
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      // getClaudeResultExitCode fires first: log has "type":"result" with is_error:false → markDone(0)
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.exitCode).toBe(0);
    } finally {
      try { rmSync(logFile); } catch {}
    }
  });

  it('uses exit code 1 when log result has is_error:true (e.g. API timeout)', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });

    const logFile = join(tmpdir(), `tamtam-is-error-${Date.now()}.log`);
    const resultLine = '{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":1000,"total_cost_usd":0,"session_id":"s2","result":"Stream idle timeout"}';
    writeFileSync(logFile, resultLine + '\n');

    const job: JobData = {
      id: 'job-is-error',
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      // getClaudeResultExitCode fires first: log has "type":"result" with is_error:true → markDone(1)
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.exitCode).toBe(1);
    } finally {
      try { rmSync(logFile); } catch {}
    }
  });

  it('uses exit code 1 for is_error:true on agent: kind too', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });

    const logFile = join(tmpdir(), `tamtam-agent-is-error-${Date.now()}.log`);
    const resultLine = '{"type":"result","subtype":"error_api","is_error":true,"duration_ms":500,"total_cost_usd":0,"session_id":"s3","result":"Rate limited"}';
    writeFileSync(logFile, resultLine + '\n');

    const job: JobData = {
      id: 'job-agent-is-error',
      project: 'proj',
      kind: 'agent:my-agent',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.exitCode).toBe(1);
    } finally {
      try { rmSync(logFile); } catch {}
    }
  });

  it('does NOT override exit code for test kind even with a result in the log', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: -1 });

    const logFile = join(tmpdir(), `tamtam-test-kind-${Date.now()}.log`);
    const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":200,"total_cost_usd":0,"session_id":"s3","result":"ok"}';
    writeFileSync(logFile, resultLine + '\n');

    const job: JobData = {
      id: 'job-test-kind',
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      // logHasClaudeResult check is only for run/review → skipped for test kind
      const status = await probeJobStatusFn(job);
      // pm2 reports done with exitCode=-1, no override for test kind
      expect(status).toBe('done');
      expect(job.exitCode).toBe(-1);
    } finally {
      try { rmSync(logFile); } catch {}
    }
  });

  // Regression: an `agent:*` job created via createJob(project, kind, 0, '')
  // would spend hundreds of ms awaiting `pm2 start` before updateJob persisted
  // the real pid. A concurrent duplicate-check (/api/agents/[id]/run) would
  // call probeJobStatus on the in-flight sibling, hit the pid<=0 fast-path,
  // and markDone(-1) — which also pm2-deletes the nascent process. User
  // symptom: phantom "exit -1 @ 0s" row next to the successful run.
  it("returns 'running' for a freshly-created pid=0 job (spawn grace)", async () => {
    const job: JobData = {
      id: 'job-spawn-grace',
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
    expect(job.exitCode).toBeNull();
    // pm2 getJobStatus must not be consulted — the job hasn't been registered yet.
    expect(getJobStatusMock).not.toHaveBeenCalled();
  });

  it("returns 'done' and marks exit -1 once a pid=0 job exceeds the spawn grace and pm2 forgot it", async () => {
    // pm2 has no record of this job → truly dead.
    getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });

    const job: JobData = {
      id: 'job-spawn-grace-expired',
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: 0,
      logPath: null,
      // 60 s ago — well past the 30 s grace window.
      startedAt: Date.now() / 1000 - 60,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(-1);
    expect(job.finishedAt).not.toBeNull();
  });

  it("returns 'running' for a freshly-created pid=-1 job (negative pid within grace)", async () => {
    // pid can be -1 when createJob writes a placeholder before pm2 start completes.
    // The grace window applies to all pid<=0, not just pid===0.
    const job: JobData = {
      id: 'job-spawn-grace-neg',
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: -1,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
    expect(getJobStatusMock).not.toHaveBeenCalled();
  });

  it("returns 'done' for a pid=-1 job that exceeds the spawn grace when pm2 forgot it", async () => {
    getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });

    const job: JobData = {
      id: 'job-spawn-grace-neg-expired',
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: -1,
      logPath: null,
      startedAt: Date.now() / 1000 - 60,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(-1);
    expect(job.finishedAt).not.toBeNull();
  });

  // Regression: long-running release meta-job. pm2 `start` raced pm2 `jlist`
  // and job.pid stayed 0. After the 30 s spawn grace, the old probe path
  // unconditionally markDone'd the release with exit -1 — which then surfaced
  // in the Terminal as red-text "# release finished — exit 0" followed by
  // "exit -1" plus a wall of raw NDJSON from extractLogDetail.
  it("pid=0 past grace but pm2 still reports online → stays running (no spurious markDone -1)", async () => {
    getJobStatusMock.mockResolvedValue({ status: 'running', exitCode: null });

    const job: JobData = {
      id: 'release-long-running',
      project: 'proj',
      kind: 'release',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000 - 120,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
    expect(job.exitCode).toBeNull();
  });

  it('pid=0 past grace and pm2 reports done 0 → markDone(0), not -1', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });

    const job: JobData = {
      id: 'release-clean-finish',
      project: 'proj',
      kind: 'release',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000 - 120,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(0);
  });
});

describe('probeJobStatus – test/action kind liveness via process.kill', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ getJobStatus: vi.fn(), deleteJob: vi.fn() }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('test kind with live pid returns running (does not hit pm2)', async () => {
    const livePid = process.pid;
    const job: JobData = {
      id: 'job-test-live',
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: livePid,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
  });

  it('action kind with live pid returns running', async () => {
    const job: JobData = {
      id: 'job-action-live',
      project: 'proj',
      kind: 'action',
      prompt: null,
      pid: process.pid,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
  });

  it('test kind with dead pid returns done', async () => {
    const job: JobData = {
      id: 'job-test-dead',
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: 2147483647,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(['running', 'done']).toContain(status);
  });
});

describe('runCompletionHooks – fix→review auto-trigger', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let getJobStatusMock: ReturnType<typeof vi.fn>;
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;

  function makeFixJob(overrides: Partial<JobData> = {}): JobData {
    return {
      id: 'fix-job-1',
      project: 'my-proj',
      kind: 'fix',
      prompt: null,
      pid: 12345,
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
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 999, logPath: '/tmp/rev.log' });
    getJobStatusMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: getJobStatusMock,
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        testCommand: null,
        testCronEnabled: false,
        testCronSchedule: null,
        autoPushEnabled: true,
      }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('calls startProjectReview after a fix job finishes with exitCode 0', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    const job = makeFixJob();

    await probeJobStatusFn(job);

    expect(job.exitCode).toBe(0);
    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('does not call startProjectReview when fix job exits non-zero', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 1 });
    const job = makeFixJob();

    await probeJobStatusFn(job);

    expect(job.exitCode).toBe(1);
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does not call startProjectReview for a review job (only fix triggers it)', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    const job = makeFixJob({ id: 'review-job-x', kind: 'review' });

    await probeJobStatusFn(job);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does not call startProjectReview for a run job', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    const job = makeFixJob({ id: 'run-job-x', kind: 'run' });

    await probeJobStatusFn(job);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startProjectReview throws', async () => {
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    startProjectReviewMock.mockRejectedValue(new Error('review service down'));
    const job = makeFixJob();

    // should not throw even when startProjectReview fails
    await expect(probeJobStatusFn(job)).resolves.toBe('done');
  });
});

describe('runCompletionHooks – auto-push pipeline', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startProjectTestMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let isReviewedMock: ReturnType<typeof vi.fn>;

  function makeJob(kind: string, logPath: string | null, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-job`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 12345,
      logPath,
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
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-autopush-test-'));

    startProjectTestMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'test-auto', pid: 999, logPath: '/tmp/t.log', testCmd: 'pnpm test' });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'pushed' });
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'committed' });
    getProjectTestConfigMock = vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: true });
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    resolveProjectPathMock = vi.fn().mockReturnValue('/proj');
    isReviewedMock = vi.fn().mockResolvedValue(false);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
      isReviewed: isReviewedMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 1, logPath: '' });
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-auto', pid: 2 });
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({
      startProjectTest: startProjectTestMock,
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: startProjectPushMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: startProjectCommitMock,
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: startFixFromJobMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: getProjectTestConfigMock,
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('finalizes active release job with exit 0 when push succeeds', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-job-push', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    const job = makeJob('push', null, { releaseId: 'release-job-push' });
    await markDoneFn(job, 0);

    const releaseRow = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-job-push');
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.exitCode).toBe(0);
  });

  it('finalizes active release job with exit 1 when push fails', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-job-push-fail', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    const job = makeJob('push', null, { releaseId: 'release-job-push-fail' });
    await markDoneFn(job, 1);

    const releaseRow = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-job-push-fail');
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.exitCode).toBe(1);
  });

  it('skips finalization when DB row already has finishedAt set (concurrent probe guard)', async () => {
    const now = Date.now() / 1000;
    // Simulate a job that a concurrent probe already finalized in the DB,
    // but whose in-memory JobData still has finishedAt === null.
    testDb.db.insert(schema.jobs).values({
      id: 'run-job', project: 'my-proj', kind: 'run',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: now - 1, exitCode: 0,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    const job = makeJob('run', null); // in-memory finishedAt === null
    expect(job.finishedAt).toBeNull();
    await markDoneFn(job, 0);

    // The DB-level guard should have synced finishedAt onto the in-memory object...
    expect(job.finishedAt).not.toBeNull();
    // ...and should not have fired any hooks (no review, commit, or fix started).
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('does not finalize a release job that is already done (idempotent)', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-job-already-done', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 20, finishedAt: now - 5, exitCode: 0,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    const job = makeJob('push', null);
    await markDoneFn(job, 0);

    // Already-done release job should not be re-finalized (finishedAt stays the same)
    const releaseRow = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-job-already-done');
    expect(releaseRow?.exitCode).toBe(0);
  });

  it('starts commit when review finishes with LGTM and auto-push is enabled', async () => {
    const logFile = join(tempDir, 'lgtm.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(execMock).not.toHaveBeenCalledWith('git', ['-C', '/proj', 'add', '-A'], { timeout: 10_000 });
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not stage local worktree after a PR review', async () => {
    const logFile = join(tempDir, 'pr-lgtm.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, {
      contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 12 }),
    });

    await markDoneFn(job, 0);

    expect(execMock).not.toHaveBeenCalledWith('git', ['-C', '/proj', 'add', '-A'], { timeout: 10_000 });
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
  });

  it('starts a fix when review verdict is NEEDS ATTENTION and auto-push is enabled', async () => {
    const logFile = join(tempDir, 'needs.log');
    writeFileSync(logFile, 'Verdict: NEEDS ATTENTION\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts a fix when review verdict is DO NOT SHIP', async () => {
    const logFile = join(tempDir, 'dns.log');
    writeFileSync(logFile, 'Verdict: DO NOT SHIP\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not chain anything when auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const logFile = join(tempDir, 'lgtm-off.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('starts a review when tests pass and auto-push is enabled', async () => {
    // Provide uncommitted changes so the hook takes the review path.
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('does not chain when test fails', async () => {
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts fix when test fails and autoPushEnabled is on', async () => {
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('starts fix when test fails and only autoCommitEnabled is on', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false });
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not start fix when test fails and neither auto flag is set', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false, autoCommitEnabled: false });
    const job = makeJob('test', null);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('starts fix on test failure even when prior fix count would otherwise hit the cap (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      testDb.db
        .insert(schema.jobs)
        .values({
          id: `testfail-prior-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 200 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: 1,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
        } as any)
        .run();
    }
    const job = makeJob('test', null);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('starts fix when test fails during an active release (inRelease=true)', async () => {
    // Neither auto flag is set, but there's an active release job — should still fix.
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false, autoCommitEnabled: false });
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'active-release-for-testfail', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();
    const job = makeJob('test', null, { releaseId: 'active-release-for-testfail' });

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('continues gracefully when test-fail startFixFromJob throws', async () => {
    startFixFromJobMock.mockRejectedValueOnce(new Error('spawn error'));
    const job = makeJob('test', null);

    await expect(markDoneFn(job, 1)).resolves.toBeUndefined();
  });

  it('does not start review when test passes but auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass and git status shows no uncommitted changes', async () => {
    // exec returns empty stdout → no uncommitted changes → push directly, skip review
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('starts review when tests pass, worktree is clean, and local commits are unpushed', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })    // git status → clean
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' }); // git rev-list @{u}..HEAD → ahead
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass, worktree is clean, and a fresh LGTM already exists', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'fresh-lgtm-review',
      project: 'my-proj',
      kind: 'review',
      prompt: null,
      pid: 777,
      logPath: join(tempDir, 'fresh-lgtm-review.log'),
      startedAt: now - 60,
      finishedAt: now - 10,
      exitCode: 0,
      seen: 1,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any).run();
    writeFileSync(join(tempDir, 'fresh-lgtm-review.log'), 'Verdict: LGTM\n');
    isReviewedMock.mockResolvedValue(true);
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('re-runs review when tests pass, worktree is clean, and the LGTM is stale after a new commit', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'stale-lgtm-review',
      project: 'my-proj',
      kind: 'review',
      prompt: null,
      pid: 777,
      logPath: join(tempDir, 'stale-lgtm-review.log'),
      startedAt: now - 60,
      finishedAt: now - 10,
      exitCode: 0,
      seen: 1,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any).run();
    writeFileSync(join(tempDir, 'stale-lgtm-review.log'), 'Verdict: LGTM\n');
    isReviewedMock.mockResolvedValue(false);
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass and project path cannot be resolved', async () => {
    // resolveProjectPath returns null → cannot check changes → treat as no changes → push
    resolveProjectPathMock.mockReturnValueOnce(null);
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('pushes directly when tests pass and git status check fails (non-zero exit)', async () => {
    execMock.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'not a repo' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('test→push (no commit needed) when autoCommitEnabled=true and autoPushEnabled=false and no uncommitted changes', async () => {
    // When no uncommitted changes exist, nothing to commit, so push directly.
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startProjectCommit throws', async () => {
    startProjectCommitMock.mockRejectedValue(new Error('git remote down'));
    const logFile = join(tempDir, 'lgtm-throw.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('continues gracefully when startProjectReview throws', async () => {
    startProjectReviewMock.mockRejectedValue(new Error('spawn failure'));
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('always starts fix on NEEDS ATTENTION even when prior fix count would otherwise hit the cap (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      testDb.db
        .insert(schema.jobs)
        .values({
          id: `prior-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 100 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: 1,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
        } as any)
        .run();
    }

    const logFile = join(tempDir, 'needs-cap.log');
    writeFileSync(logFile, 'Verdict: NEEDS ATTENTION\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('starts a final fix on DO NOT SHIP even after prior fix cap (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release-cap.log');
    writeFileSync(releaseLog, '# release start\n');
    testDb.db.insert(schema.jobs).values({
      id: 'release-cap',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
      startedAt: now - 300,
      finishedAt: null,
      exitCode: null,
      seen: 0,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any).run();
    for (let i = 0; i < 3; i++) {
      testDb.db.insert(schema.jobs).values({
        id: `release-cap-fix-${i}`,
        project: 'my-proj',
        kind: 'fix',
        prompt: null,
        pid: 500 + i,
        logPath: null,
        startedAt: now - 240 + i,
        finishedAt: now - 230 + i,
        exitCode: 0,
        seen: 1,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        releaseId: 'release-cap',
      } as any).run();
    }

    const logFile = join(tempDir, 'review-cap.log');
    writeFileSync(logFile, 'Findings:\n- Finding ID: still-broken\n  Root cause: server bypass\nVerdict: DO NOT SHIP\n');
    const job = makeJob('review', logFile, { id: 'review-cap-final', releaseId: 'release-cap' });

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
    // Release stays open — the trailing fix continues; the cap fires on the
    // next review (fix→review hook), not here.
    const releaseRow = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-cap');
    expect(releaseRow?.finishedAt).toBeNull();
  });

  it('starts fix on NEEDS ATTENTION even with prior fixes in the same release (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      testDb.db
        .insert(schema.jobs)
        .values({
          id: `same-release-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 300 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: 1,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
          releaseId: 'release-current',
        } as any)
        .run();
    }

    const logFile = join(tempDir, 'release-scoped-cap.log');
    writeFileSync(logFile, 'Verdict: NEEDS ATTENTION\n');
    const job = makeJob('review', logFile, { releaseId: 'release-current' });

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not count fixes from a different release against the current release cap', async () => {
    const now = Date.now() / 1000;
    // 3 fix jobs from a PREVIOUS release — should not eat into current release's budget
    for (let i = 0; i < 3; i++) {
      testDb.db
        .insert(schema.jobs)
        .values({
          id: `old-release-fix-${i}`,
          project: 'my-proj',
          kind: 'fix',
          prompt: null,
          pid: 400 + i,
          logPath: null,
          startedAt: now - 60 * i,
          finishedAt: now - 60 * i + 5,
          exitCode: 0,
          seen: 1,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
          releaseId: 'release-previous',
        } as any)
        .run();
    }

    const logFile = join(tempDir, 'new-release-not-capped.log');
    writeFileSync(logFile, 'Verdict: NEEDS ATTENTION\n');
    // New release with a different releaseId — previous release fixes should not count
    const job = makeJob('review', logFile, { releaseId: 'release-new' });

    await markDoneFn(job, 0);

    // The current release has 0 fixes, so it should start a fix
    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not auto-chain fix→review when auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const job = makeJob('fix', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('starts commit (not push) when autoCommitEnabled is set without autoPushEnabled after LGTM review', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    const logFile = join(tempDir, 'lgtm-commit-only.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('starts commit when autoPushEnabled=true even if autoCommitEnabled=true after LGTM review', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: true, releaseAfterRun: false });
    const logFile = join(tempDir, 'lgtm-full-push.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('auto-chains fix→review when autoCommitEnabled=true and autoPushEnabled=false', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    const job = makeJob('fix', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('auto-chains test→review when autoCommitEnabled=true and there are uncommitted changes', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false });
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('auto-chains test→commit (skips review) when autoCommitEnabled=true, reviewDisabled=true, and there are uncommitted changes', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false, reviewDisabled: true });
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('auto-chains test→push when reviewDisabled=true and only unpushed commits remain', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: false, releaseAfterRun: false, reviewDisabled: true });
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  describe('fix-ci auto-retry on fast crash', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries fix-ci when it crashes within the fast-crash window', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const now = Date.now() / 1000;
      // Simulate a crashed-fast fix-ci: exit != 0, duration ~1s.
      const job = makeJob('fix-ci', null);
      job.startedAt = now - 1;

      await markDoneFn(job, -1);
      // Drain scheduled retry.
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/api\/projects\/by-project\/my-proj\/fix-ci$/);
      expect(init.method).toBe('POST');
      vi.unstubAllGlobals();
    });

    it('does not retry when fix-ci ran longer than the fast-crash threshold', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const now = Date.now() / 1000;
      const job = makeJob('fix-ci', null);
      job.startedAt = now - 30; // 30s of runtime — real failure, not boot crash

      await markDoneFn(job, 1);
      await vi.runAllTimersAsync();

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not retry when the max retry count has been exceeded', async () => {
      // Insert 3 prior fix-ci jobs so the count gate trips.
      const now = Date.now() / 1000;
      for (let i = 0; i < 3; i++) {
        testDb.db.insert(schema.jobs).values({
          id: `prior-fixci-${i}`, project: 'my-proj', kind: 'fix-ci',
          prompt: null, pid: 200 + i, logPath: null,
          startedAt: now - i, finishedAt: now - i + 1, exitCode: -1,
          seen: 1, durationMs: null, inputTokens: null, outputTokens: null,
          cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
        } as any).run();
      }

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const job = makeJob('fix-ci', null);
      job.startedAt = now - 1;
      await markDoneFn(job, -1);
      await vi.runAllTimersAsync();

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not retry a successful fix-ci (exit 0)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const job = makeJob('fix-ci', null);
      job.startedAt = Date.now() / 1000 - 1;
      await markDoneFn(job, 0);
      await vi.runAllTimersAsync();

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});

describe('markDone – isClaudeKind exit-code override for new kinds', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;

  function makeJob(kind: string, logPath: string | null): JobData {
    return {
      id: `${kind.replace(':', '-')}-override-test`,
      project: 'proj',
      kind,
      prompt: null,
      pid: 12345,
      logPath,
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
  }

  const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":500,"total_cost_usd":0,"session_id":"s1","result":"ok"}';

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-isclaudekind-'));

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/pipeline/start-fix-push', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      startFixPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['fix', 'fix-ci', 'fix-push', 'agent:my-agent'])(
    'overrides exit code to 0 for kind=%s when result is_error=false',
    async (kind) => {
      const logFile = join(tempDir, `${kind.replace(':', '-')}.log`);
      writeFileSync(logFile, resultLine + '\n');
      const job = makeJob(kind, logFile);

      await markDoneFn(job, -1);

      expect(job.exitCode).toBe(0);
    }
  );

  it('does NOT override exit code for push kind', async () => {
    const logFile = join(tempDir, 'push.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('push', logFile);

    await markDoneFn(job, -1);

    expect(job.exitCode).toBe(-1);
  });

  it('does NOT override exit code for test kind', async () => {
    const logFile = join(tempDir, 'test-kind.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('test', logFile);

    await markDoneFn(job, -1);

    expect(job.exitCode).toBe(-1);
  });

  it('does not override when result has is_error=true and exitCode is non-zero', async () => {
    const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s2","result":""}';
    const logFile = join(tempDir, 'fix-error.log');
    writeFileSync(logFile, errorLine + '\n');
    const job = makeJob('fix', logFile);

    await markDoneFn(job, -1);

    expect(job.exitCode).toBe(-1);
  });

  it('overrides exitCode 0 to 1 when result has is_error=true', async () => {
    // probeJobStatus calls markDone(job, 0) for any terminal result line; if
    // is_error=true the logical outcome was a failure and exitCode must become 1.
    const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s3","result":"404 model unavailable"}';
    const logFile = join(tempDir, 'fix-error-zero.log');
    writeFileSync(logFile, errorLine + '\n');
    const job = makeJob('fix', logFile);

    await markDoneFn(job, 0);

    expect(job.exitCode).toBe(1);
  });

  it.each(['run', 'review', 'fix-ci', 'fix-push', 'agent:my-agent'])(
    'overrides exitCode 0 to 1 for kind=%s when is_error=true',
    async (kind) => {
      const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s4","result":"error"}';
      const logFile = join(tempDir, `${kind.replace(':', '-')}-err-zero.log`);
      writeFileSync(logFile, errorLine + '\n');
      const job = makeJob(kind, logFile);

      await markDoneFn(job, 0);

      expect(job.exitCode).toBe(1);
    }
  );

  it('does NOT override exitCode 0 to 1 for non-claude kind (push) with is_error=true', async () => {
    const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s5","result":"error"}';
    const logFile = join(tempDir, 'push-err-zero.log');
    writeFileSync(logFile, errorLine + '\n');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 0);

    expect(job.exitCode).toBe(0);
  });
});

describe('runCompletionHooks – fix-push auto-fix chain', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startFixPushMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let isHookRejectionMock: ReturnType<typeof vi.fn>;
  let isTestFailureRejectionMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  function makeJob(kind: string, logPath: string | null, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-chain-test`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 12345,
      logPath,
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
      ...overrides,
    };
  }

  function insertActiveRelease() {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'active-release-job',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: now - 5,
      finishedAt: null,
      exitCode: null,
      seen: 0,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any).run();
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-fixpush-chain-'));

    startFixPushMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-push-1', pid: 999, logPath: '/tmp/fp.log' });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'pushed' });
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'committed' });
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-1', pid: 888, logPath: '/tmp/rev.log' });
    isHookRejectionMock = vi.fn().mockReturnValue(false);
    isTestFailureRejectionMock = vi.fn().mockReturnValue(false);
    getProjectTestConfigMock = vi.fn().mockReturnValue({ autoPushEnabled: false });
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    resolveProjectPathMock = vi.fn().mockReturnValue('/proj');

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: getProjectTestConfigMock,
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix-push', () => ({
      isHookRejection: isHookRejectionMock,
      isTestFailureRejection: isTestFailureRejectionMock,
      startFixPush: startFixPushMock,
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('spawns fix-push when push fails with a hook rejection', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const logFile = join(tempDir, 'push-hook-fail.log');
    writeFileSync(logFile, 'husky - pre-commit hook exited with code 1');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(isHookRejectionMock).toHaveBeenCalled();
    expect(startFixPushMock).toHaveBeenCalledWith('my-proj', expect.stringContaining('husky'));
  });

  it('does not spawn fix-push when push fails for a non-hook reason', async () => {
    isHookRejectionMock.mockReturnValue(false);
    const logFile = join(tempDir, 'push-network-fail.log');
    writeFileSync(logFile, 'error: failed to push some refs to origin');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixPushMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix-push when push fails because pre-push tests broke', async () => {
    // Hook rejection is true (husky pre-push failed) but it's a test failure,
    // not a lint nit — we don't want to enter the fix-push retry loop because
    // Claude can't reliably "fix" flaky integration tests.
    isHookRejectionMock.mockReturnValue(true);
    isTestFailureRejectionMock.mockReturnValue(true);
    const logFile = join(tempDir, 'push-tests-fail.log');
    writeFileSync(logFile, 'husky - pre-push script failed (code 1)\n FAIL  src/foo.test.ts\n Tests  1 failed | 100 passed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(isTestFailureRejectionMock).toHaveBeenCalled();
    expect(startFixPushMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix-push when push succeeds', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const job = makeJob('push', null);

    await markDoneFn(job, 0);

    expect(startFixPushMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix-push when the attempt cap (2) has been reached', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const now = Date.now() / 1000;
    for (let i = 0; i < 2; i++) {
      testDb.db.insert(schema.jobs).values({
        id: `prior-fixpush-${i}`,
        project: 'my-proj',
        kind: 'fix-push',
        prompt: null,
        pid: 100 + i,
        logPath: null,
        startedAt: now - i * 10,
        finishedAt: now - i * 10 + 5,
        exitCode: 0,
        seen: 1,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      } as any).run();
    }
    const logFile = join(tempDir, 'push-hook-capped.log');
    writeFileSync(logFile, 'pre-commit failed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixPushMock).not.toHaveBeenCalled();
  });

  it('still spawns fix-push when only 1 prior attempt exists (cap is 2)', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'prior-fixpush-0',
      project: 'my-proj',
      kind: 'fix-push',
      prompt: null,
      pid: 100,
      logPath: null,
      startedAt: now - 10,
      finishedAt: now - 5,
      exitCode: 0,
      seen: 1,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any).run();
    const logFile = join(tempDir, 'push-hook-one-prior.log');
    writeFileSync(logFile, 'pre-commit failed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixPushMock).toHaveBeenCalledTimes(1);
  });

  it('calls startProjectCommit when fix-push finishes with exit 0', async () => {
    const job = makeJob('fix-push', null);

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('does not call startProjectCommit when fix-push exits non-zero', async () => {
    const job = makeJob('fix-push', null);

    await markDoneFn(job, 1);

    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startProjectCommit throws after fix-push success', async () => {
    startProjectCommitMock.mockRejectedValue(new Error('commit service down'));
    const job = makeJob('fix-push', null);

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('chains review LGTM → commit when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    insertActiveRelease();
    const logFile = join(tempDir, 'lgtm-release.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('chains test pass → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    insertActiveRelease();
    // Provide uncommitted changes so the hook routes to review rather than push.
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('chains fix success → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    insertActiveRelease();
    const job = makeJob('fix', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('does NOT chain review when neither inRelease nor auto-push', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    const logFile = join(tempDir, 'lgtm-no-release.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).not.toHaveBeenCalled();
  });
});

describe('runCompletionHooks – release-after-run', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startReleaseMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let setPendingReleaseMock: ReturnType<typeof vi.fn>;
  let shouldKeepPendingReleaseMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;

  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind.replace(':', '-')}-rar-test`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 12345,
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
      ...overrides,
    };
  }

  async function loadMarkDone({
    releaseAfterRun = true,
    schedulingModuleThrows = false,
  }: {
    releaseAfterRun?: boolean | null;
    schedulingModuleThrows?: boolean;
  } = {}) {
    vi.resetModules();
    testDb = createTestDb();
    startReleaseMock = vi.fn().mockResolvedValue({ ok: true, step: 'review', jobId: 'rel-1', releaseJobId: 'rel-job-1', message: 'Running review' });
    getProjectTestConfigMock = vi.fn().mockReturnValue(
      releaseAfterRun === null
        ? null
        : { autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun }
    );
    setPendingReleaseMock = vi.fn();
    shouldKeepPendingReleaseMock = vi.fn().mockReturnValue(false);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    if (schedulingModuleThrows) {
      vi.doMock('@/lib/scheduling/scheduling', () => {
        throw new Error('failed to load scheduling');
      });
    } else {
      vi.doMock('@/lib/scheduling/scheduling', () => ({
        getProjectTestConfig: getProjectTestConfigMock,
      }));
    }
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: startReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: setPendingReleaseMock,
      shouldKeepPendingRelease: shouldKeepPendingReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'not needed' }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'not needed' }),
    }));
    vi.doMock('@/lib/pipeline/start-fix-push', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      startFixPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'not needed' }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  }

  beforeEach(async () => {
    await loadMarkDone();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('triggers startRelease after run job finishes with exit 0 when releaseAfterRun=true', async () => {
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: 'run-rar-test',
    });
  });

  it('triggers startRelease after agent:x job finishes with exit 0 when releaseAfterRun=true', async () => {
    const job = makeJob('agent:my-agent');
    await markDoneFn(job, 0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: 'agent-my-agent-rar-test',
    });
  });

  it('triggers startRelease after fix-ci job finishes with exit 0', async () => {
    const job = makeJob('fix-ci', { id: 'fix-ci-rar-test' });
    await markDoneFn(job, 0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: 'fix-ci-rar-test',
    });
  });

  it('preserves pending release intent when fix-ci release chaining is temporarily blocked', async () => {
    shouldKeepPendingReleaseMock.mockReturnValue(true);
    startReleaseMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Release pipeline already running for my-proj',
    });
    const job = makeJob('fix-ci', { id: 'fix-ci-pending-test' });

    await markDoneFn(job, 0);

    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: 'fix-ci-pending-test',
    });
    expect(shouldKeepPendingReleaseMock).toHaveBeenCalledWith({
      ok: false,
      status: 409,
      detail: 'Release pipeline already running for my-proj',
    });
    expect(setPendingReleaseMock).toHaveBeenCalledWith('my-proj');
  });

  it('does not trigger startRelease when run job exits non-zero', async () => {
    const job = makeJob('run');
    await markDoneFn(job, 1);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease when releaseAfterRun=false', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false });
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease when the project has no config row', async () => {
    await loadMarkDone({ releaseAfterRun: null });
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease when the scheduling module import fails', async () => {
    await loadMarkDone({ schedulingModuleThrows: true });
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease for test kind', async () => {
    const job = makeJob('test');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease for review kind', async () => {
    const job = makeJob('review');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('does not trigger startRelease for push kind', async () => {
    const job = makeJob('push');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startRelease throws', async () => {
    startReleaseMock.mockRejectedValue(new Error('release service down'));
    const job = makeJob('run');
    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });
});

describe('markDone – ghIssuesCache invalidation', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;

  function makeJob(project: string, kind = 'run'): JobData {
    return {
      id: `${project}-${kind}-cache-test`,
      project,
      kind,
      prompt: null,
      pid: 0,
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
  }

  function insertCacheRow(project: string) {
    testDb.db.insert(schema.ghIssuesCache).values({
      project,
      repo: `owner/${project}`,
      prs: '[]',
      issues: '[]',
      fetchedAt: Date.now() / 1000,
    }).run();
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false }),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-fix-push', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      startFixPush: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: vi.fn().mockResolvedValue({ ok: false }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('deletes the ghIssuesCache row for the job project on markDone', async () => {
    insertCacheRow('my-proj');
    const before = testDb.db.select().from(schema.ghIssuesCache).all();
    expect(before).toHaveLength(1);

    const job = makeJob('my-proj');
    await markDoneFn(job, 0);

    const after = testDb.db.select().from(schema.ghIssuesCache).all();
    expect(after).toHaveLength(0);
  });

  it('does not delete cache rows for other projects', async () => {
    insertCacheRow('proj-a');
    insertCacheRow('proj-b');

    const job = makeJob('proj-a');
    await markDoneFn(job, 0);

    const remaining = testDb.db.select().from(schema.ghIssuesCache).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].project).toBe('proj-b');
  });

  it('succeeds silently when no cache row exists for the project', async () => {
    const job = makeJob('no-cache-proj');
    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('invalidates cache regardless of exit code', async () => {
    insertCacheRow('failing-proj');
    const job = makeJob('failing-proj');
    await markDoneFn(job, 1);

    const after = testDb.db.select().from(schema.ghIssuesCache).all();
    expect(after).toHaveLength(0);
  });
});

describe('markDone – metadata extraction skipped for release kind', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;

  const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"session_id":"ses-abc","result":"ok","modelUsage":{"claude-sonnet":{"inputTokens":100,"outputTokens":50,"cacheReadInputTokens":10,"cacheCreationInputTokens":5}}}';

  function makeJob(kind: string, logPath: string | null): JobData {
    return {
      id: `${kind.replace(':', '-')}-meta-test`,
      project: 'meta-proj',
      kind,
      prompt: null,
      pid: 1,
      logPath,
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
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-meta-'));

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-fix-push', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      startFixPush: vi.fn().mockResolvedValue({ ok: false }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT populate sessionId/tokens for release kind even when log has a result line', async () => {
    const logFile = join(tempDir, 'release.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('release', logFile);

    await markDoneFn(job, 0);

    expect(job.sessionId).toBeNull();
    expect(job.inputTokens).toBeNull();
    expect(job.outputTokens).toBeNull();
    expect(job.cacheReadTokens).toBeNull();
    expect(job.cacheCreateTokens).toBeNull();
    expect(job.durationMs).toBeNull();
  });

  it('DOES populate sessionId/tokens for non-release kinds (review)', async () => {
    const logFile = join(tempDir, 'review.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(job.sessionId).toBe('ses-abc');
    expect(job.inputTokens).toBe(100);
    expect(job.outputTokens).toBe(50);
    expect(job.cacheReadTokens).toBe(10);
    expect(job.cacheCreateTokens).toBe(5);
    expect(job.durationMs).toBe(1234);
  });

  it('DOES populate metadata for commit kind (non-release Claude job)', async () => {
    const logFile = join(tempDir, 'commit.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('commit', logFile);

    await markDoneFn(job, 0);

    expect(job.sessionId).toBe('ses-abc');
    expect(job.durationMs).toBe(1234);
  });

  it('populates model and costUsd from modelUsage for non-release kinds', async () => {
    const logFile = join(tempDir, 'run-cost.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('run', logFile);

    await markDoneFn(job, 0);

    expect(job.model).toBe('claude-sonnet');
    expect(typeof job.costUsd).toBe('number');
    expect(job.costUsd).toBeGreaterThan(0);
  });

  it('persists costUsd and model to DB after markDone', async () => {
    const logFile = join(tempDir, 'run-db.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('run', logFile);
    testDb.db.insert(schema.jobs).values({
      id: job.id, project: job.project, kind: job.kind,
      prompt: null, pid: job.pid, logPath: logFile,
      startedAt: job.startedAt, finishedAt: null, exitCode: null,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    await markDoneFn(job, 0);

    const row = testDb.db.select().from(schema.jobs).all().find(r => r.id === job.id);
    expect(row?.model).toBe('claude-sonnet');
    expect(row?.costUsd).toBeGreaterThan(0);
  });

  it('does NOT populate model or costUsd for release kind', async () => {
    const logFile = join(tempDir, 'release-cost.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('release', logFile);

    await markDoneFn(job, 0);

    expect(job.model).toBeUndefined();
    expect(job.costUsd).toBeUndefined();
  });
});

describe('runCompletionHooks – linked release scoping', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makeJob(kind: string, logPath: string | null, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-job`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 12345,
      logPath,
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
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-linked-release-test-'));

    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 1, logPath: '' });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'pushed' });
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'committed' });
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-auto', pid: 2 });
    getProjectTestConfigMock = vi.fn().mockReturnValue({
      autoPushEnabled: false,
      autoCommitEnabled: false,
      autoPrMergeEnabled: false,
      prWorkflowEnabled: false,
    });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
      isReviewed: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({
      startProjectTest: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: startProjectPushMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: startProjectCommitMock,
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: startFixFromJobMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: getProjectTestConfigMock,
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not append or auto-chain a standalone pipeline job just because another release is active', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'active-release.log');
    writeFileSync(releaseLog, '# release start\n');
    testDb.db.insert(schema.jobs).values({
      id: 'release-live',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
      startedAt: now - 20,
      finishedAt: null,
      exitCode: null,
      seen: 0,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      releaseId: 'release-live',
    } as any).run();

    const testLog = join(tempDir, 'standalone-test.log');
    writeFileSync(testLog, 'manual test output\n');
    const job = makeJob('test', testLog, { id: 'manual-test-1' });

    await markDoneFn(job, 0);

    expect(readFileSync(releaseLog, 'utf8')).not.toContain('manual test output');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
    const releaseRow = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-live');
    expect(releaseRow?.finishedAt).toBeNull();
  });

  it('appends linked child output into its own active release log', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'linked-release.log');
    writeFileSync(releaseLog, '# release start\n');
    testDb.db.insert(schema.jobs).values({
      id: 'release-linked',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
      startedAt: now - 20,
      finishedAt: null,
      exitCode: null,
      seen: 0,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      releaseId: 'release-linked',
    } as any).run();

    const childLog = join(tempDir, 'linked-pr-wait.log');
    writeFileSync(childLog, 'merge poll output\n');
    const job = makeJob('pr-wait', childLog, { id: 'linked-pr-wait-1', releaseId: 'release-linked' });

    await markDoneFn(job, 0);

    expect(readFileSync(releaseLog, 'utf8')).toContain('merge poll output');
  });
});

describe('runCompletionHooks – push→DoD (PR Workflow without auto-merge)', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startMarkDodMock: ReturnType<typeof vi.fn>;
  let launchPrWaitMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;

  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-job`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 1,
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
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-push-dod-test-'));
    startMarkDodMock = vi.fn().mockResolvedValue({ ok: true, verified: 2, total: 2, changed: true, issueNumber: 55 });
    getProjectTestConfigMock = vi.fn().mockReturnValue({
      prWorkflowEnabled: true,
      autoPrMergeEnabled: false,
      autoPushEnabled: false,
    });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/proj') }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
    launchPrWaitMock = vi.fn().mockReturnValue({ jobId: 'prwait-1' });
    vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ launchPrWait: launchPrWaitMock }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('calls startMarkDod when push succeeds with prWorkflowEnabled=true and contextMeta has prNumber', async () => {
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/55' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj', {
      prNumber: 55,
      repo: 'owner/repo',
    });
  });

  it('does not call startMarkDod when push fails', async () => {
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' }) });
    await markDoneFn(job, 1);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('calls startMarkDod in Direct Branch mode (prWorkflowEnabled=false) when push created a PR', async () => {
    // Issue-linked pushes create a PR even in Direct Branch mode; DoD should run.
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false, autoPrMergeEnabled: false });
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj', {
      prNumber: 55,
      repo: 'owner/repo',
    });
  });

  it('does not call startMarkDod when autoPrMergeEnabled=true (launchPrWait handles DoD post-merge)', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true, autoPrMergeEnabled: true });
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/55' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('does not call startMarkDod when contextMeta has no prNumber', async () => {
    const job = makeJob('push', { contextMeta: JSON.stringify({ prRepo: 'owner/repo' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('does not call startMarkDod when contextMeta is null', async () => {
    const job = makeJob('push', { contextMeta: null });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startMarkDod throws', async () => {
    startMarkDodMock.mockRejectedValue(new Error('dod failed'));
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' }) });
    await expect(markDoneFn(job, 0)).resolves.not.toThrow();
  });
});

describe('markDone – DB-level idempotency guard', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makeJob(id: string, kind = 'push'): JobData {
    return {
      id,
      project: 'guard-proj',
      kind,
      prompt: null,
      pid: 999,
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
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-db-guard-'));

    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: false, detail: 'guard' });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: false, detail: 'guard' });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false }),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: startProjectPushMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: false, detail: 'guard' }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, detail: 'guard' }),
    }));
    vi.doMock('@/lib/pipeline/start-fix-push', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      startFixPush: vi.fn().mockResolvedValue({ ok: false, detail: 'guard' }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns early and syncs finishedAt when DB row is already finalized', async () => {
    const alreadyFinishedAt = Date.now() / 1000 - 60;
    testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-1', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: alreadyFinishedAt - 10,
      finishedAt: alreadyFinishedAt,
      exitCode: 0,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    const job = makeJob('db-guard-job-1');
    // Stale in-memory object: finishedAt is null even though DB says it's done
    expect(job.finishedAt).toBeNull();

    await markDoneFn(job, 0);

    // job.finishedAt must be synced from DB
    expect(job.finishedAt).toBe(alreadyFinishedAt);
    // No completion hooks should fire (no push/review triggered)
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does not overwrite the DB finishedAt when returning early from DB guard', async () => {
    const alreadyFinishedAt = Date.now() / 1000 - 60;
    testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-2', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: alreadyFinishedAt - 10,
      finishedAt: alreadyFinishedAt,
      exitCode: 0,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    const job = makeJob('db-guard-job-2');
    await markDoneFn(job, 99);

    const row = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'db-guard-job-2');
    // DB row should still have the original finishedAt, not a new one
    expect(row?.finishedAt).toBe(alreadyFinishedAt);
    expect(row?.exitCode).toBe(0); // not overwritten with 99
  });

  it('proceeds normally when DB row has finishedAt = null', async () => {
    testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-3', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: Date.now() / 1000 - 5,
      finishedAt: null,
      exitCode: null,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any).run();

    const job = makeJob('db-guard-job-3');
    await markDoneFn(job, 0);

    expect(job.finishedAt).not.toBeNull();
    const row = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'db-guard-job-3');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
  });

  it('proceeds normally when no DB row exists (new job not yet persisted)', async () => {
    // Job exists only in memory (no DB row inserted yet)
    const job = makeJob('db-guard-no-row');
    await markDoneFn(job, 0);

    // Should have finalized as normal
    expect(job.finishedAt).not.toBeNull();
    expect(job.exitCode).toBe(0);
  });

  it('in-memory guard still fires before the DB check (finishedAt already set)', async () => {
    const job = makeJob('db-guard-inmem');
    job.finishedAt = Date.now() / 1000 - 5; // already finalized in memory

    const snapshotFinishedAt = job.finishedAt;
    await markDoneFn(job, 99);

    // In-memory guard should have returned before any DB interaction
    expect(job.finishedAt).toBe(snapshotFinishedAt); // unchanged
    expect(job.exitCode).toBeNull(); // not overwritten
  });
});

describe('runCompletionHooks – abort short-circuit', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;

  function makeJob(kind: string, id?: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: id ?? `${kind}-job`,
      project: 'abort-proj',
      kind,
      prompt: null,
      pid: 100,
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
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-1' });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true });
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc' });
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-1' });
    getProjectTestConfigMock = vi.fn().mockReturnValue({ autoPushEnabled: true });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: getProjectTestConfigMock,
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not chain to next step when active release has abortedAt set', async () => {
    const now = Date.now() / 1000;
    // Insert an aborted release job — finishedAt is set (as the abort handler does)
    testDb.db.insert(schema.jobs).values({
      id: 'release-aborted', project: 'abort-proj', kind: 'release',
      prompt: null, pid: 0, logPath: null,
      startedAt: now - 30, finishedAt: now - 1, exitCode: -3,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      abortedAt: now - 1,
    } as any).run();

    // Step job must carry releaseId so the abort check can find the release
    const reviewJob = makeJob('review', 'review-after-abort', { releaseId: 'release-aborted' });
    await markDoneFn(reviewJob, 0);

    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not chain fix→review when active release is aborted', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values({
      id: 'release-aborted-2', project: 'abort-proj', kind: 'release',
      prompt: null, pid: 0, logPath: null,
      startedAt: now - 30, finishedAt: now - 1, exitCode: -3,
      seen: 0, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      abortedAt: now - 1,
    } as any).run();

    const fixJob = makeJob('fix', 'fix-after-abort', { releaseId: 'release-aborted-2' });
    await markDoneFn(fixJob, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });
});

describe('persistVerdict', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let createJobFn: typeof import('@/lib/jobs/job-storage').createJob;
  let getJobFn: typeof import('@/lib/jobs/job-storage').getJob;
  let persistVerdictFn: typeof import('@/lib/jobs/job-storage').persistVerdict;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/jobs/job-storage');
    createJobFn = mod.createJob;
    getJobFn = mod.getJob;
    persistVerdictFn = mod.persistVerdict;
  });

  afterEach(() => vi.resetModules());

  it('writes verdict to DB and in-memory cache', () => {
    const job = createJobFn('proj', 'review', 1, '/log');
    persistVerdictFn(job.id, 'LGTM');

    const stored = testDb.sqlite
      .prepare('SELECT verdict FROM jobs WHERE id = ?')
      .get(job.id) as { verdict: string };
    expect(stored.verdict).toBe('LGTM');

    const cached = getJobFn(job.id);
    expect(cached?.verdict).toBe('LGTM');
  });

  it('updates an existing verdict', () => {
    const job = createJobFn('proj', 'review', 2, '/log');
    persistVerdictFn(job.id, 'NEEDS ATTENTION');
    persistVerdictFn(job.id, 'DO NOT SHIP');

    const stored = testDb.sqlite
      .prepare('SELECT verdict FROM jobs WHERE id = ?')
      .get(job.id) as { verdict: string };
    expect(stored.verdict).toBe('DO NOT SHIP');
    expect(getJobFn(job.id)?.verdict).toBe('DO NOT SHIP');
  });

  it('silently no-ops for an unknown jobId (no throw)', () => {
    expect(() => persistVerdictFn('nonexistent-job', 'LGTM')).not.toThrow();
  });
});
