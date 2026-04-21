import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function createTestDb() {
  const sqlite = new Database(':memory:');
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
      log_pruned INTEGER DEFAULT 0
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

describe('runCompletionHooks – mark-dod integration', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startMarkDodMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/job-storage').markDone;
  let tempDir: string;

  function makeReviewJob(logPath: string | null): JobData {
    return {
      id: 'review-job',
      project: 'my-proj',
      kind: 'review',
      prompt: null,
      pid: 0,
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
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-mark-dod-test-'));

    startMarkDodMock = vi.fn().mockResolvedValue({
      ok: true, jobId: 'dod-job', issueNumber: 7, verified: 2, total: 2, changed: true,
    });
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-job' });
    getProjectTestConfigMock = vi.fn().mockReturnValue({ autoPushEnabled: true, autoCommitEnabled: false });

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
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
    vi.doMock('@/lib/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: true, jobId: 'rev-job' }),
    }));
    vi.doMock('@/lib/start-test', () => ({
      startProjectTest: vi.fn().mockResolvedValue({ ok: true, jobId: 'test-job' }),
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

  it('calls startMarkDod before startProjectPush when review verdict is LGTM and auto-push is on', async () => {
    const logFile = join(tempDir, 'lgtm.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const callOrder: string[] = [];
    startMarkDodMock.mockImplementation(async () => {
      callOrder.push('mark-dod');
      return { ok: true, jobId: 'j', issueNumber: 1, verified: 0, total: 0, changed: false };
    });
    startProjectPushMock.mockImplementation(async () => {
      callOrder.push('push');
      return { ok: true, commitSha: 'abc', message: 'pushed' };
    });

    await markDoneFn(makeReviewJob(logFile), 0);

    expect(callOrder).toEqual(['mark-dod', 'push']);
  });

  it('calls startMarkDod with the project name', async () => {
    const logFile = join(tempDir, 'lgtm2.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj');
  });

  it('still calls startProjectPush when startMarkDod returns ok:false (non-fatal)', async () => {
    const logFile = join(tempDir, 'lgtm3.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    startMarkDodMock.mockResolvedValue({ ok: false, status: 400, detail: 'no issue context' });
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startProjectPushMock).toHaveBeenCalled();
  });

  it('still calls startProjectPush when startMarkDod throws (non-fatal)', async () => {
    const logFile = join(tempDir, 'lgtm4.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    startMarkDodMock.mockRejectedValue(new Error('mark-dod crashed'));
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startProjectPushMock).toHaveBeenCalled();
  });

  it('does not call startMarkDod when verdict is NEEDS ATTENTION', async () => {
    const logFile = join(tempDir, 'needs.log');
    writeFileSync(logFile, 'Verdict: NEEDS ATTENTION\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('does not call startMarkDod when verdict is DO NOT SHIP', async () => {
    const logFile = join(tempDir, 'dns.log');
    writeFileSync(logFile, 'Verdict: DO NOT SHIP\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('does not call startMarkDod when review exit code is non-zero', async () => {
    const logFile = join(tempDir, 'fail.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 1);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('does not call startMarkDod when auto-push is disabled (no pipeline active)', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: false });
    const logFile = join(tempDir, 'lgtm-off.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('calls startMarkDod when autoCommitEnabled is true (no autoPush)', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: true });
    const logFile = join(tempDir, 'lgtm-commit.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).toHaveBeenCalled();
  });
});
