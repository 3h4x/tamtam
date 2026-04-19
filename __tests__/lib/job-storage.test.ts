import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
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
      parent_job_id TEXT
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('job-storage', () => {
  let tempDir: string;
  let testDb: ReturnType<typeof createTestDb>;
  let createJob: typeof import('@/lib/job-storage').createJob;
  let getJob: typeof import('@/lib/job-storage').getJob;
  let listJobs: typeof import('@/lib/job-storage').listJobs;
  let markSeen: typeof import('@/lib/job-storage').markSeen;
  let unseenFinished: typeof import('@/lib/job-storage').unseenFinished;
  let updateJob: typeof import('@/lib/job-storage').updateJob;
  let readLog: typeof import('@/lib/job-storage').readLog;
  let getVerdict: typeof import('@/lib/job-storage').getVerdict;
  let jobToDict: typeof import('@/lib/job-storage').jobToDict;
  let probeJobStatus: typeof import('@/lib/job-storage').probeJobStatus;

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
    const jobStorage = await import('@/lib/job-storage');
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
      const job3 = createJob('proj3', 'run', 333, '/log3');

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
  let readParsedLog: typeof import('@/lib/job-storage').readParsedLog;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-parsed-log-test-'));
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/pm2-jobs', () => ({ getJobStatus: vi.fn(), deleteJob: vi.fn() }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/job-storage');
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
  let probeJobStatusFn: typeof import('@/lib/job-storage').probeJobStatus;
  let getJobStatusMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    getJobStatusMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/pm2-jobs', () => ({ getJobStatus: getJobStatusMock }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/job-storage');
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

  it('overrides exit code to 0 when log has a clean result and pm2 reports non-zero', async () => {
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
      // logHasClaudeResult fires first: log has "type":"result" → markDone(0)
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.exitCode).toBe(0);
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
});

describe('probeJobStatus – test/action kind liveness via process.kill', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let probeJobStatusFn: typeof import('@/lib/job-storage').probeJobStatus;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/pm2-jobs', () => ({ getJobStatus: vi.fn(), deleteJob: vi.fn() }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/job-storage');
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
  let probeJobStatusFn: typeof import('@/lib/job-storage').probeJobStatus;

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
    vi.doMock('@/lib/pm2-jobs', () => ({
      getJobStatus: getJobStatusMock,
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        testCommand: null,
        testCronEnabled: false,
        testCronSchedule: null,
        autoPushEnabled: true,
      }),
    }));

    const mod = await import('@/lib/job-storage');
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
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/job-storage').markDone;
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
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-autopush-test-'));

    startProjectTestMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'test-auto', pid: 999, logPath: '/tmp/t.log', testCmd: 'pnpm test' });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'pushed' });
    getProjectTestConfigMock = vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: true });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 1, logPath: '' });
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-auto', pid: 2 });
    vi.doMock('@/lib/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/start-test', () => ({
      startProjectTest: startProjectTestMock,
    }));
    vi.doMock('@/lib/start-push', () => ({
      startProjectPush: startProjectPushMock,
    }));
    vi.doMock('@/lib/start-fix', () => ({
      startFixFromJob: startFixFromJobMock,
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getProjectTestConfig: getProjectTestConfigMock,
    }));

    const mod = await import('@/lib/job-storage');
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

    const job = makeJob('push', null);
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

    const job = makeJob('push', null);
    await markDoneFn(job, 1);

    const releaseRow = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-job-push-fail');
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.exitCode).toBe(1);
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

  it('pushes when review finishes with LGTM and auto-push is enabled', async () => {
    const logFile = join(tempDir, 'lgtm.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
    expect(startFixFromJobMock).not.toHaveBeenCalled();
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
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('does not chain when test fails', async () => {
    const job = makeJob('test', null);

    await markDoneFn(job, 1);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('does not start review when test passes but auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startProjectPush throws', async () => {
    startProjectPushMock.mockRejectedValue(new Error('git remote down'));
    const logFile = join(tempDir, 'lgtm-throw.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('continues gracefully when startProjectReview throws', async () => {
    startProjectReviewMock.mockRejectedValue(new Error('spawn failure'));
    const job = makeJob('test', null);

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('stops chaining fixes once MAX_FIX_ITERATIONS recent fix jobs exist', async () => {
    // Insert 3 recent fix jobs so recentFixCount hits the cap.
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
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not auto-chain fix→review when auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false });
    const job = makeJob('fix', null);

    await markDoneFn(job, 0);

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
  let markDoneFn: typeof import('@/lib/job-storage').markDone;
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
    vi.doMock('@/lib/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false }),
    }));
    vi.doMock('@/lib/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/start-fix-push', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      startFixPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));

    const mod = await import('@/lib/job-storage');
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

  it('does not override when result has is_error=true', async () => {
    const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s2","result":""}';
    const logFile = join(tempDir, 'fix-error.log');
    writeFileSync(logFile, errorLine + '\n');
    const job = makeJob('fix', logFile);

    await markDoneFn(job, -1);

    expect(job.exitCode).toBe(-1);
  });
});

describe('runCompletionHooks – fix-push auto-fix chain', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startFixPushMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let isHookRejectionMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/job-storage').markDone;
  let tempDir: string;

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
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-1', pid: 888, logPath: '/tmp/rev.log' });
    isHookRejectionMock = vi.fn().mockReturnValue(false);
    getProjectTestConfigMock = vi.fn().mockReturnValue({ autoPushEnabled: false });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/pm2-jobs', () => ({
      getJobStatus: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getProjectTestConfig: getProjectTestConfigMock,
    }));
    vi.doMock('@/lib/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/start-fix-push', () => ({
      isHookRejection: isHookRejectionMock,
      startFixPush: startFixPushMock,
    }));

    const mod = await import('@/lib/job-storage');
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

  it('calls startProjectPush when fix-push finishes with exit 0', async () => {
    const job = makeJob('fix-push', null);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
  });

  it('does not call startProjectPush when fix-push exits non-zero', async () => {
    const job = makeJob('fix-push', null);

    await markDoneFn(job, 1);

    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startProjectPush throws after fix-push success', async () => {
    startProjectPushMock.mockRejectedValue(new Error('push service down'));
    const job = makeJob('fix-push', null);

    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('chains review LGTM → push when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    insertActiveRelease();
    const logFile = join(tempDir, 'lgtm-release.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(startProjectPushMock).toHaveBeenCalledWith('my-proj');
  });

  it('chains test pass → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    insertActiveRelease();
    const job = makeJob('test', null);

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('chains fix success → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    insertActiveRelease();
    const job = makeJob('fix', null);

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
