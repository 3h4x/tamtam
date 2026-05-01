import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq } from 'drizzle-orm';
import type { JobData } from '@/lib/jobs/types';

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
      log_pruned INTEGER DEFAULT 0,
      cost_usd REAL,
      model TEXT,
      release_id TEXT,
      aborted_at REAL,
      prompt_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      prs TEXT NOT NULL DEFAULT '[]',
      issues TEXT NOT NULL DEFAULT '[]',
      fetched_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeJobRow(overrides: Record<string, unknown>) {
  const now = Date.now() / 1000;
  return {
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    seen: 0,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    userPrompt: null,
    contextMeta: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: 0,
    costUsd: null,
    model: null,
    releaseId: null,
    abortedAt: null,
    ...overrides,
  };
}

// ─── reconcileStaleRelease ────────────────────────────────────────────────────

describe('reconcileStaleRelease', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let reconcileStaleRelease: typeof import('@/lib/jobs/job-storage').reconcileStaleRelease;
  let releaseLockMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id: `${kind}-job`,
      project: 'proj',
      kind,
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: now,
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
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-lifecycle-test-'));
    releaseLockMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
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
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: false,
        autoCommitEnabled: false,
        releaseAfterRun: false,
        prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: releaseLockMock,
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({
      pruneProjectLogs: vi.fn(),
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0,
        fix_ci_retry_window_seconds: 120,
        fix_ci_fast_crash_ms: 5000,
      }),
    }));
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns early for non-pipeline-step job kinds (run)', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values(
      makeJobRow({ id: 'release-x', project: 'proj', kind: 'release', startedAt: now - 60 }) as any
    ).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const runJob = makeJob('run', { project: 'proj' });
    await fn(runJob);

    // Release must still be unfinished — reconcile should have done nothing
    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-x')).get();
    expect(row?.finishedAt).toBeNull();
  });

  it('returns early when no active release exists', async () => {
    const now = Date.now() / 1000;
    // Insert an already-finished release — findActiveReleaseJob won't pick it up
    testDb.db.insert(schema.jobs).values(
      makeJobRow({ id: 'done-release', project: 'proj', kind: 'release', startedAt: now - 120, finishedAt: now - 60, exitCode: 0 }) as any
    ).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const testJob = makeJob('test', { project: 'proj' });
    await fn(testJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'done-release')).get();
    expect(row?.finishedAt).not.toBeNull(); // still the original value, unchanged
  });

  it('defers when a pipeline child is still running (finishedAt=null in cache)', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-r1', project: 'proj', kind: 'release', startedAt: now - 60 }) as any,
      makeJobRow({ id: 'test-r1', project: 'proj', kind: 'test', startedAt: now - 50, finishedAt: null }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const doneJob = makeJob('push', { project: 'proj', finishedAt: now - 1, exitCode: 0 });
    await fn(doneJob);

    // Release must still be active — child test job is still running
    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-r1')).get();
    expect(row?.finishedAt).toBeNull();
  });

  it('defers when the chain finished but within the 5s grace window', async () => {
    const now = Date.now() / 1000;
    // Last step finished 2 seconds ago — within RELEASE_RECONCILE_GRACE_MS (5s)
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-grace', project: 'proj', kind: 'release', startedAt: now - 30 }) as any,
      makeJobRow({ id: 'push-grace', project: 'proj', kind: 'push', startedAt: now - 10, finishedAt: now - 2, exitCode: 0 }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const pushJob = makeJob('push', { project: 'proj', finishedAt: now - 2, exitCode: 0 });
    await fn(pushJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-grace')).get();
    expect(row?.finishedAt).toBeNull();
  });

  it('finalizes release with exit 0 when all steps done and grace period has elapsed', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-stale', project: 'proj', kind: 'release', startedAt: now - 60 }) as any,
      makeJobRow({ id: 'test-stale', project: 'proj', kind: 'test', startedAt: now - 50, finishedAt: now - 30, exitCode: 0 }) as any,
      makeJobRow({ id: 'push-stale', project: 'proj', kind: 'push', startedAt: now - 25, finishedAt: now - 15, exitCode: 0 }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const pushJob = makeJob('push', { project: 'proj', finishedAt: now - 15, exitCode: 0 });
    await fn(pushJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-stale')).get();
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
  });

  it('finalizes release with exit 1 when any step in the chain failed', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-fail', project: 'proj', kind: 'release', startedAt: now - 60 }) as any,
      makeJobRow({ id: 'test-fail', project: 'proj', kind: 'test', startedAt: now - 50, finishedAt: now - 40, exitCode: 1 }) as any,
      makeJobRow({ id: 'fix-fail', project: 'proj', kind: 'fix', startedAt: now - 35, finishedAt: now - 15, exitCode: 0 }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const fixJob = makeJob('fix', { project: 'proj', finishedAt: now - 15, exitCode: 0 });
    await fn(fixJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-fail')).get();
    expect(row?.finishedAt).not.toBeNull();
    // test step failed — release must report exit 1
    expect(row?.exitCode).toBe(1);
  });
});

// ─── reviewIsStuck convergence guard (tested through markDone) ───────────────

describe('reviewIsStuck convergence guard', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makeReviewJob(id: string, logPath: string | null, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind: 'review',
      prompt: null,
      pid: 0,
      logPath,
      startedAt: now,
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
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-stuck-test-'));
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-auto' });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
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
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: true,
        autoCommitEnabled: false,
        releaseAfterRun: false,
        prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({
      pruneProjectLogs: vi.fn(),
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0,
        fix_ci_retry_window_seconds: 120,
        fix_ci_fast_crash_ms: 5000,
      }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: startFixFromJobMock,
    }));
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT start a fix when the previous review in the same release has identical findings', async () => {
    const now = Date.now() / 1000;
    const findings = '## Findings\n- memory leak in cache.ts\n- missing error handler in api/route.ts\n';
    const prevLog = join(tempDir, 'prev-review.log');
    writeFileSync(prevLog, findings + 'Verdict: NEEDS ATTENTION\n');

    // Insert a previous review with same findings, already finished, in the same release
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-stuck', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
      makeJobRow({
        id: 'prev-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-stuck',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    // Current review has identical findings — fix loop should be stopped
    const curLog = join(tempDir, 'cur-review.log');
    writeFileSync(curLog, findings + 'Verdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('cur-review', curLog, {
      releaseId: 'release-stuck',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('DOES start a fix when the previous review has different findings', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-review2.log');
    writeFileSync(prevLog, '## Findings\n- old bug in foo.ts\nVerdict: NEEDS ATTENTION\n');

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-diff', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
      makeJobRow({
        id: 'prev-review2',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-diff',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    // Current review has different findings — fix should proceed
    const curLog = join(tempDir, 'cur-review2.log');
    writeFileSync(curLog, '## Findings\n- different bug in bar.ts\nVerdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('cur-review2', curLog, {
      releaseId: 'release-diff',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith('cur-review2');
  });

  it('starts a fix on the first review in a release (no previous to compare against)', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values(
      makeJobRow({ id: 'release-first', project: 'proj', kind: 'release', startedAt: now - 60 }) as any
    ).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const curLog = join(tempDir, 'first-review.log');
    writeFileSync(curLog, '## Findings\n- some issue in baz.ts\nVerdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('first-review', curLog, {
      releaseId: 'release-first',
      startedAt: now - 30,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith('first-review');
  });
});
