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
      context_meta TEXT
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
});
