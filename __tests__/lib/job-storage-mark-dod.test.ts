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
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
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
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' });
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
    vi.doMock('@/lib/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
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

  it('calls startMarkDod before startProjectCommit when review verdict is LGTM and auto-push is on', async () => {
    const logFile = join(tempDir, 'lgtm.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const callOrder: string[] = [];
    startMarkDodMock.mockImplementation(async () => {
      callOrder.push('mark-dod');
      return { ok: true, jobId: 'j', issueNumber: 1, verified: 0, total: 0, changed: false };
    });
    startProjectCommitMock.mockImplementation(async () => {
      callOrder.push('commit');
      return { ok: true, commitSha: 'abc', message: 'committed' };
    });

    await markDoneFn(makeReviewJob(logFile), 0);

    expect(callOrder).toEqual(['mark-dod', 'commit']);
  });

  it('calls startMarkDod with the project name', async () => {
    const logFile = join(tempDir, 'lgtm2.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj');
  });

  it('still calls startProjectCommit when startMarkDod returns ok:false (non-fatal)', async () => {
    const logFile = join(tempDir, 'lgtm3.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    startMarkDodMock.mockResolvedValue({ ok: false, status: 400, detail: 'no issue context' });
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startProjectCommitMock).toHaveBeenCalled();
  });

  it('still calls startProjectCommit when startMarkDod throws (non-fatal)', async () => {
    const logFile = join(tempDir, 'lgtm4.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    startMarkDodMock.mockRejectedValue(new Error('mark-dod crashed'));
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startProjectCommitMock).toHaveBeenCalled();
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
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('calls startMarkDod when autoCommitEnabled is true (no autoPush)', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: true });
    const logFile = join(tempDir, 'lgtm-commit.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).toHaveBeenCalled();
  });
});

describe('runCompletionHooks – mark-dod excluded from pipeline endpoint', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/job-storage').markDone;
  let notifyMock: ReturnType<typeof vi.fn>;

  function insertReleaseJob(db: ReturnType<typeof createTestDb>['db'], id: string) {
    const now = Date.now() / 1000;
    db.insert(schema.jobs).values({
      id,
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: now - 10,
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

  function makeJob(kind: string, exitCodeOverride?: number): JobData {
    return {
      id: `${kind}-job`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: exitCodeOverride ?? null,
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
    notifyMock = vi.fn().mockResolvedValue(undefined);

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
    vi.doMock('@/lib/start-mark-dod', () => ({
      startMarkDod: vi.fn().mockResolvedValue({ ok: false, detail: 'no issue' }),
    }));
    vi.doMock('@/lib/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false, detail: 'no remote' }),
    }));
    vi.doMock('@/lib/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: false, detail: 'nothing to commit' }),
    }));
    vi.doMock('@/lib/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, detail: 'no' }),
    }));
    vi.doMock('@/lib/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false, detail: 'no' }),
    }));
    vi.doMock('@/lib/start-test', () => ({
      startProjectTest: vi.fn().mockResolvedValue({ ok: false, detail: 'no' }),
    }));
    vi.doMock('@/lib/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: false }),
    }));
    vi.doMock('@/lib/notifications', () => ({ notify: notifyMock }));
    vi.doMock('@/lib/pipeline-lock', () => ({ releaseLock: vi.fn() }));

    const mod = await import('@/lib/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not finalize the active release job when mark-dod completes with exit 0', async () => {
    insertReleaseJob(testDb.db, 'release-dod-0');
    await markDoneFn(makeJob('mark-dod'), 0);
    const row = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-dod-0');
    expect(row?.finishedAt).toBeNull();
    expect(row?.exitCode).toBeNull();
  });

  it('does not finalize the active release job when mark-dod completes with exit 1', async () => {
    insertReleaseJob(testDb.db, 'release-dod-1');
    await markDoneFn(makeJob('mark-dod'), 1);
    const row = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-dod-1');
    expect(row?.finishedAt).toBeNull();
    expect(row?.exitCode).toBeNull();
  });

  it('does not send a notification when mark-dod completes', async () => {
    insertReleaseJob(testDb.db, 'release-dod-notify');
    await markDoneFn(makeJob('mark-dod'), 0);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('pr-wait still finalizes the active release job with exit 0 (regression)', async () => {
    insertReleaseJob(testDb.db, 'release-prwait-0');
    await markDoneFn(makeJob('pr-wait'), 0);
    const row = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-prwait-0');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
  });

  it('pr-wait still finalizes the active release job with exit 1 (regression)', async () => {
    insertReleaseJob(testDb.db, 'release-prwait-1');
    await markDoneFn(makeJob('pr-wait'), 1);
    const row = testDb.db.select().from(schema.jobs).all().find(r => r.id === 'release-prwait-1');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(1);
  });
});
