import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
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
      prompt_bytes INTEGER,
      work_summary TEXT,
      modified_files TEXT
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

describe('GitHub board sync failures are non-fatal', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
  });

  afterEach(() => {
    vi.resetModules();
    testDb.sqlite.close();
  });

  it('still creates a job when the start sync fails', async () => {
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/github/project-board', () => ({
      queueJobBoardSync: vi.fn().mockRejectedValue(new Error('boom')),
    }));

    const { createJob, getJob } = await import('@/lib/jobs/job-storage');
    const job = createJob('proj', 'run', 99999, '/tmp/log');
    await Promise.resolve();

    expect(getJob(job.id)?.id).toBe(job.id);
  });

  it('still completes a job when the finish sync fails', async () => {
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/github/project-board', () => ({
      queueJobBoardSync: vi.fn().mockRejectedValue(new Error('boom')),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({
      pruneProjectLogs: vi.fn(),
    }));
    // markDone on a kind:'run' job with exitCode 0 normally triggers
    // the release-after-run pipeline, which spawns real PM2 subprocesses
    // and leaks kernel resources. Mock the chain so this test exercises
    // only the board-sync hook.
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: () => ({ releaseAfterRun: false }),
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }),
    }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'mocked' }),
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: vi.fn(),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      runAutoChainGates: () => null,
    }));

    const { createJob, markDone, getJob } = await import('@/lib/jobs/job-storage');
    const job = createJob('proj', 'run', 99999, '/tmp/log');
    await markDone(job, 0);

    expect(getJob(job.id)?.finishedAt).not.toBeNull();
    expect(getJob(job.id)?.exitCode).toBe(0);
  });
});
