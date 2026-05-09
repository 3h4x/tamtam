import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
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
      verdict TEXT,
      cost_usd REAL,
      model TEXT,
      release_id TEXT,
      aborted_at REAL,
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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeJobRow<T extends Record<string, unknown>>(overrides: T) {
  const now = Date.now() / 1000;
  return {
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
    userPrompt: null,
    contextMeta: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: false,
    costUsd: null,
    model: null,
    releaseId: null,
    abortedAt: null,
    ...overrides,
  };
}

function ndjsonText(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  });
}

// ─── reconcileStaleRelease ────────────────────────────────────────────────────

describe('reconcileStaleRelease', () => {
  let testDb: ReturnType<typeof createTestDb>;
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
      makeJobRow({ id: 'test-stale', project: 'proj', kind: 'test', releaseId: 'release-stale', startedAt: now - 50, finishedAt: now - 30, exitCode: 0 }) as any,
      makeJobRow({ id: 'push-stale', project: 'proj', kind: 'push', releaseId: 'release-stale', startedAt: now - 25, finishedAt: now - 15, exitCode: 0 }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const pushJob = makeJob('push', { project: 'proj', releaseId: 'release-stale', finishedAt: now - 15, exitCode: 0 });
    await fn(pushJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-stale')).get();
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
  });

  it('finalizes release with exit 1 when any step in the chain failed', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-fail', project: 'proj', kind: 'release', startedAt: now - 60 }) as any,
      makeJobRow({ id: 'test-fail', project: 'proj', kind: 'test', releaseId: 'release-fail', startedAt: now - 50, finishedAt: now - 40, exitCode: 1 }) as any,
      makeJobRow({ id: 'fix-fail', project: 'proj', kind: 'fix', releaseId: 'release-fail', startedAt: now - 35, finishedAt: now - 15, exitCode: 0 }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    const fixJob = makeJob('fix', { project: 'proj', releaseId: 'release-fail', finishedAt: now - 15, exitCode: 0 });
    await fn(fixJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-fail')).get();
    expect(row?.finishedAt).not.toBeNull();
    // test step failed — release must report exit 1
    expect(row?.exitCode).toBe(1);
  });

  it('breaks the chain and excludes jobs that start more than 60s after the previous edge', async () => {
    const now = Date.now() / 1000;
    // release → test (finishes at now-50) → review starts 90s later (gap > 60s → excluded from chain)
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-gap', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
      makeJobRow({ id: 'test-gap', project: 'proj', kind: 'test', startedAt: now - 110, finishedAt: now - 50, exitCode: 0 }) as any,
      // review starts 90 seconds after test finished (now-50 + 90 = now+40) — but we keep it in the past:
      // use finishedAt = now - 55 so grace window passes, then review starts at now - 55 + 90 = now+35 — too far in future
      // Actually: release at now-200, test finishes at now-120, review starts at now-50 (gap = 70s > 60s)
    ]).run();
    // Re-insert with correct timing: release at now-200, test at now-190 finishing at now-130, review at now-50 (gap 80s)
    testDb.db.delete(schema.jobs).run();
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-gap', project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({ id: 'test-gap', project: 'proj', kind: 'test', releaseId: 'release-gap', startedAt: now - 190, finishedAt: now - 130, exitCode: 0 }) as any,
      // review starts 80 seconds after test finished (now-130 + 80 = now-50) — gap > 60s → excluded
      makeJobRow({ id: 'review-gap', project: 'proj', kind: 'review', releaseId: 'release-gap', startedAt: now - 50, finishedAt: now - 20, exitCode: 0 }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    // Trigger via the review job finishing (it's within its own chain, but not the release's)
    const reviewJob = makeJob('review', { project: 'proj', releaseId: 'release-gap', finishedAt: now - 20, exitCode: 0 });
    await fn(reviewJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-gap')).get();
    // The chain should include only the test step; the review is too far away.
    // Release is finalized because test finished long ago (now-130, well past the 5s grace).
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0); // only the test step (exit 0) is in the chain
  });
});

describe('runCompletionHooks abort cleanup', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let releaseLockMock: ReturnType<typeof vi.fn>;
  let deleteJobMock: ReturnType<typeof vi.fn>;
  let notifyMock: ReturnType<typeof vi.fn>;

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
    releaseLockMock = vi.fn();
    deleteJobMock = vi.fn().mockResolvedValue(undefined);
    notifyMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: deleteJobMock,
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
      notify: notifyMock,
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
  });

  it('finalizes an aborted release after the inline step finishes late', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values([
      makeJobRow({
        id: 'release-timeout',
        project: 'proj',
        kind: 'release',
        startedAt: now - 60,
        abortedAt: now - 10,
      }) as any,
      makeJobRow({
        id: 'commit-timeout',
        project: 'proj',
        kind: 'commit',
        releaseId: 'release-timeout',
        startedAt: now - 30,
        finishedAt: now - 1,
        exitCode: -3,
      }) as any,
    ]).run();

    const { runCompletionHooks } = await import('@/lib/jobs/job-storage');

    await runCompletionHooks(
      makeJob('commit', {
        id: 'commit-timeout',
        project: 'proj',
        releaseId: 'release-timeout',
        finishedAt: now - 1,
        exitCode: -3,
      }),
    );

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-timeout')).get();
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(-3);
    expect(row?.abortedAt).not.toBeNull();
    expect(releaseLockMock).toHaveBeenCalledWith('proj', 'release-timeout');
    expect(deleteJobMock).toHaveBeenCalledTimes(1);
    expect(deleteJobMock).toHaveBeenCalledWith('release-timeout');
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      event: 'release_aborted',
      project: 'proj',
      job_id: 'release-timeout',
    }));
  });
});

// ─── reviewIsStuck convergence guard (tested through markDone) ───────────────

describe('reviewIsStuck convergence guard', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let fileReviewExhaustionIssueMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
  let notifyMock: ReturnType<typeof vi.fn>;
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
    fileReviewExhaustionIssueMock = vi.fn().mockResolvedValue({ ok: true, issueNumber: 42, issueUrl: 'https://github.com/owner/repo/issues/42' });
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'commit ok', jobId: 'commit-auto' });
    notifyMock = vi.fn().mockResolvedValue(undefined);

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
      notify: notifyMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        review_fix_max_iterations: 3,
      }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: startFixFromJobMock,
    }));
    vi.doMock('@/lib/pipeline/review-exhaustion-fallback', () => ({
      fileReviewExhaustionIssue: fileReviewExhaustionIssueMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: startProjectCommitMock,
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

  it('does NOT start a fix when structured finding IDs repeat with different wording', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-structured-review.log');
    writeFileSync(prevLog, ndjsonText('Findings:\n- Finding ID: server-url-bypass\n  Root cause: missing server validation\nVerdict: DO NOT SHIP\n'));

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-structured-stuck', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
      makeJobRow({
        id: 'prev-structured-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-structured-stuck',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const curLog = join(tempDir, 'cur-structured-review.log');
    writeFileSync(curLog, ndjsonText('Findings:\n- Finding ID: server-url-bypass\n  Root cause: alternate API still bypasses canonical parser\nVerdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-structured-review', curLog, {
      releaseId: 'release-structured-stuck',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does NOT treat incidental id lines as structured finding IDs', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-incidental-id-review.log');
    writeFileSync(prevLog, ndjsonText('Findings:\n- Root cause: missing auth\n  id: shared-placeholder\nVerdict: DO NOT SHIP\n'));

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-incidental-id', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
      makeJobRow({
        id: 'prev-incidental-id-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-incidental-id',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const curLog = join(tempDir, 'cur-incidental-id-review.log');
    writeFileSync(curLog, ndjsonText('Findings:\n- Root cause: missing cache invalidation\n  id: shared-placeholder\nVerdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-incidental-id-review', curLog, {
      releaseId: 'release-incidental-id',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).toHaveBeenCalledOnce();
  });

  it('finalizes release with exit 1 when repeated review findings stop convergence', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release-stuck-final.log');
    writeFileSync(releaseLog, '# release\n');
    const findings = 'Findings:\n- Finding ID: duplicate-bypass\n  Root cause: duplicate canonicalization missing\n';
    const prevLog = join(tempDir, 'prev-review-final.log');
    writeFileSync(prevLog, ndjsonText(findings + 'Verdict: NEEDS ATTENTION\n'));

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-stuck-final', project: 'proj', kind: 'release', logPath: releaseLog, startedAt: now - 120 }) as any,
      makeJobRow({
        id: 'prev-review-final',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-stuck-final',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const curLog = join(tempDir, 'cur-review-final.log');
    writeFileSync(curLog, ndjsonText(findings + 'Verdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-review-final', curLog, {
      releaseId: 'release-stuck-final',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    const row = testDb.db.select().from(schema.jobs).all().find((r) => r.id === 'release-stuck-final');
    expect(row?.exitCode).toBe(1);
    expect(row?.finishedAt).not.toBeNull();
    expect(fileReviewExhaustionIssueMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });

  it('DOES start a fix when the previous review has different findings', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-review2.log');
    writeFileSync(prevLog, ndjsonText('## Findings\n- old bug in foo.ts\nVerdict: NEEDS ATTENTION\n'));

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

  it('stops the release when the prior fix claimed an ID fixed but review still flags it', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release-contradict.log');
    writeFileSync(releaseLog, '# release\n');

    const fixLog = join(tempDir, 'fix-contradict.log');
    writeFileSync(fixLog, ndjsonText([
      'Fix checklist:',
      '- Finding ID: multiline-escaped-quotes-truncate-imported-values',
      '  Status: fixed',
      '  Files changed: Store.swift',
    ].join('\n')));

    const prevReviewLog = join(tempDir, 'prev-review-contradict.log');
    writeFileSync(prevReviewLog, ndjsonText([
      'Findings:',
      '- Finding ID: multiline-escaped-quotes-truncate-imported-values',
      'Verdict: DO NOT SHIP',
    ].join('\n')));

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-contradict', project: 'proj', kind: 'release', logPath: releaseLog, startedAt: now - 200 }) as any,
      makeJobRow({
        id: 'prev-review-contradict',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-contradict',
        logPath: prevReviewLog,
        startedAt: now - 180,
        finishedAt: now - 170,
        exitCode: 0,
      }) as any,
      makeJobRow({
        id: 'fix-contradict',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-contradict',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const curLog = join(tempDir, 'cur-review-contradict.log');
    writeFileSync(curLog, ndjsonText([
      'Findings:',
      '- Finding ID: multiline-escaped-quotes-truncate-imported-values',
      '  Root cause: still bypasses canonical parser',
      'Verdict: DO NOT SHIP',
    ].join('\n')));
    const curReview = makeReviewJob('cur-review-contradict', curLog, {
      releaseId: 'release-contradict',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
    expect(fileReviewExhaustionIssueMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    const row = testDb.db.select().from(schema.jobs).all().find((r) => r.id === 'release-contradict');
    expect(row?.exitCode).toBe(1);
    expect(row?.finishedAt).not.toBeNull();
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });

  it('does NOT treat fix claiming Status: not fixed as a contradiction', async () => {
    const now = Date.now() / 1000;
    const fixLog = join(tempDir, 'fix-honest.log');
    writeFileSync(fixLog, ndjsonText([
      'Fix checklist:',
      '- Finding ID: tricky-finding',
      '  Status: not fixed',
      '  Remaining risk: needs deeper refactor',
    ].join('\n')));

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-honest', project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({
        id: 'fix-honest',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-honest',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const curLog = join(tempDir, 'cur-review-honest.log');
    writeFileSync(curLog, ndjsonText([
      'Findings:',
      '- Finding ID: tricky-finding',
      'Verdict: NEEDS ATTENTION',
    ].join('\n')));
    const curReview = makeReviewJob('cur-review-honest', curLog, {
      releaseId: 'release-honest',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith('cur-review-honest');
  });

  it('DOES start a fix when fix claimed a different ID than the review now flags', async () => {
    const now = Date.now() / 1000;
    const fixLog = join(tempDir, 'fix-different.log');
    writeFileSync(fixLog, ndjsonText([
      'Fix checklist:',
      '- Finding ID: original-finding',
      '  Status: fixed',
    ].join('\n')));

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'release-different', project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({
        id: 'fix-different',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-different',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const curLog = join(tempDir, 'cur-review-different.log');
    writeFileSync(curLog, ndjsonText([
      'Findings:',
      '- Finding ID: brand-new-finding',
      'Verdict: NEEDS ATTENTION',
    ].join('\n')));
    const curReview = makeReviewJob('cur-review-different', curLog, {
      releaseId: 'release-different',
      startedAt: now - 60,
    });

    await markDoneFn(curReview, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith('cur-review-different');
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

// ─── verification cap (counts reviews/tests, not fixes) ──────────────────────

describe('fix→review review-count cap', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let fileReviewExhaustionIssueMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
  let notifyMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makeFixJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind: 'fix',
      prompt: null,
      pid: 99999,
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

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-review-cap-'));
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'review-next' });
    fileReviewExhaustionIssueMock = vi.fn().mockResolvedValue({ ok: true, issueNumber: 7, issueUrl: 'https://github.com/owner/repo/issues/7' });
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'commit ok', jobId: 'commit-auto' });
    notifyMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: notifyMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        review_fix_max_iterations: 3,
      }),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/review-exhaustion-fallback', () => ({
      fileReviewExhaustionIssue: fileReviewExhaustionIssueMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: startProjectCommitMock,
    }));
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips review #(MAX+1) when MAX reviews have already run, even with different findings each time', async () => {
    // Default MAX_STEP_ITERATIONS = 3. Insert 3 prior reviews with DISTINCT
    // findings (so reviewIsStuck and fixContradictsReview both return false).
    // The new cap must still trigger and skip the 4th review.
    const now = Date.now() / 1000;
    const releaseId = 'release-scope-creep';
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 600 }) as any,
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 500, finishedAt: now - 480, exitCode: 0 }) as any,
      makeJobRow({ id: 'f1', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r1', startedAt: now - 470, finishedAt: now - 450, exitCode: 0 }) as any,
      makeJobRow({ id: 'r2', project: 'proj', kind: 'review', releaseId, startedAt: now - 440, finishedAt: now - 420, exitCode: 0 }) as any,
      makeJobRow({ id: 'f2', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r2', startedAt: now - 410, finishedAt: now - 390, exitCode: 0 }) as any,
      makeJobRow({ id: 'r3', project: 'proj', kind: 'review', releaseId, startedAt: now - 380, finishedAt: now - 360, exitCode: 0 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');

    // The current fix's parent is r3 (a review) — fromTestFailure is false,
    // so we hit the fix→review branch where the cap should bite.
    const f3 = makeFixJob('f3', { releaseId, parentJobId: 'r3', startedAt: now - 30, finishedAt: null, exitCode: null });

    await markDone(f3, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
    // fix_loop_exhausted should fire as the release-stop notification.
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('still chains to review when fewer than MAX reviews have run', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-under-cap';
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');

    const f1 = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });
    await markDone(f1, 0);

    expect(startProjectReviewMock).toHaveBeenCalledOnce();
    expect(startProjectReviewMock).toHaveBeenCalledWith('proj');
  });

  it('does NOT file an exhaustion issue or start commit when the capped review is DO NOT SHIP', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-cap-do-not-ship';
    const reviewLog = join(tempDir, 'r3-review.log');
    writeFileSync(reviewLog, ndjsonText([
      'Findings:',
      '- Finding ID: auth-bypass',
      'Verdict: DO NOT SHIP',
    ].join('\n')));

    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 600 }) as any,
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 500, finishedAt: now - 480, exitCode: 0 }) as any,
      makeJobRow({ id: 'f1', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r1', startedAt: now - 470, finishedAt: now - 450, exitCode: 0 }) as any,
      makeJobRow({ id: 'r2', project: 'proj', kind: 'review', releaseId, startedAt: now - 440, finishedAt: now - 420, exitCode: 0 }) as any,
      makeJobRow({ id: 'f2', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r2', startedAt: now - 410, finishedAt: now - 390, exitCode: 0 }) as any,
      makeJobRow({ id: 'r3', project: 'proj', kind: 'review', releaseId, logPath: reviewLog, startedAt: now - 380, finishedAt: now - 360, exitCode: 0 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    const f3 = makeFixJob('f3', { releaseId, parentJobId: 'r3', startedAt: now - 30, finishedAt: null, exitCode: null });

    await markDone(f3, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(fileReviewExhaustionIssueMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });
});

describe('review_fix_max_iterations only caps review-side recovery', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startProjectTestMock: ReturnType<typeof vi.fn>;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let fileReviewExhaustionIssueMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let notifyMock: ReturnType<typeof vi.fn>;

  function makeFixJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind: 'fix',
      prompt: null,
      pid: 99999,
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

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    startProjectTestMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'test-next' });
    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'review-next' });
    fileReviewExhaustionIssueMock = vi.fn().mockResolvedValue({ ok: true, issueNumber: 7, issueUrl: 'https://github.com/owner/repo/issues/7' });
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'commit ok', jobId: 'commit-auto' });
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-auto' });
    notifyMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: notifyMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        review_fix_max_iterations: 1,
      }),
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/review-exhaustion-fallback', () => ({
      fileReviewExhaustionIssue: fileReviewExhaustionIssueMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: startProjectCommitMock,
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: startFixFromJobMock,
    }));
  });

  afterEach(() => {
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
    vi.resetModules();
  });

  it('still re-runs tests after a failed test fix when review_fix_max_iterations is 1', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-test-retry';
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({ id: 't1', project: 'proj', kind: 'test', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 1 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 't1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(startProjectTestMock).toHaveBeenCalledOnce();
    expect(startProjectTestMock).toHaveBeenCalledWith('proj');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(fileReviewExhaustionIssueMock).not.toHaveBeenCalled();
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).not.toContain('fix_loop_exhausted');
  });

  it('caps the next review when review_fix_max_iterations is 1', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-review-cap-1';
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(fileReviewExhaustionIssueMock).toHaveBeenCalledOnce();
    expect(startProjectCommitMock).toHaveBeenCalledOnce();
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('stops the release when exhaustion issue filing succeeds but the follow-up commit cannot start', async () => {
    startProjectCommitMock.mockResolvedValueOnce({ ok: false, detail: 'git status failed' });
    const now = Date.now() / 1000;
    const releaseId = 'release-review-cap-commit-fail';
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(fileReviewExhaustionIssueMock).toHaveBeenCalledOnce();
    expect(startProjectCommitMock).toHaveBeenCalledOnce();
    const releaseRow = testDb.db.select().from(schema.jobs).all().find((row) => row.id === releaseId);
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('still starts a fix after a capped failed commit inside a release', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    const releaseId = 'release-commit-cap-fix';
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    const commitJob: JobData = {
      id: 'c1',
      project: 'proj',
      kind: 'commit',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: now - 30,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      releaseId,
      parentJobId: releaseId,
    };

    await markDone(commitJob, 1);

    expect(startFixFromJobMock).toHaveBeenCalledOnce();
    expect(startFixFromJobMock).toHaveBeenCalledWith('c1');
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).not.toContain('fix_loop_exhausted');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('suppresses the re-commit after the trailing fix when the commit cap is exhausted', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    const releaseId = 'release-commit-cap-stop';
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }) as any,
      makeJobRow({ id: 'c1', project: 'proj', kind: 'commit', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 1 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    const fixJob = makeFixJob('f-commit-cap', { releaseId, parentJobId: 'c1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(startProjectCommitMock).not.toHaveBeenCalled();
    const notifyEvents = notifyMock.mock.calls.map((c) => c[0]?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('still starts a fix after a capped failed commit in standalone auto-push mode', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'old-commit', project: 'proj', kind: 'commit', startedAt: now - 120, finishedAt: now - 110, exitCode: 1 }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    const commitJob: JobData = {
      id: 'standalone-commit',
      project: 'proj',
      kind: 'commit',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: now - 20,
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

    await markDone(commitJob, 1);

    expect(startFixFromJobMock).toHaveBeenCalledOnce();
    expect(startFixFromJobMock).toHaveBeenCalledWith('standalone-commit');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });
});

// ─── concurrent step finalization guard ──────────────────────────────────────

describe('concurrent step finalization guard', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;

  function makeInMemoryJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
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
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does NOT finalize the release when another pipeline step is still running', async () => {
    const now = Date.now() / 1000;
    // Insert an active release and a running test step (sibling, still running)
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'rel-1', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
      makeJobRow({ id: 'test-1', project: 'proj', kind: 'test', startedAt: now - 60, finishedAt: null }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    // A review job finishes with exit 1 (crash/failure — no chaining path fires)
    const reviewJob = makeInMemoryJob('review-1', 'review', {
      startedAt: now - 30,
      releaseId: 'rel-1',
    });

    await markDoneFn(reviewJob, 1);

    // Release should NOT be finalized — the guard defers to the still-running test
    const relRow = testDb.db
      .select({ finishedAt: schema.jobs.finishedAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, 'rel-1'))
      .get();
    expect(relRow?.finishedAt).toBeNull();
  });

  it('finalizes the release when no other step is running', async () => {
    const now = Date.now() / 1000;
    // Insert an active release with NO running siblings
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'rel-2', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const reviewJob = makeInMemoryJob('review-2', 'review', {
      startedAt: now - 30,
      releaseId: 'rel-2',
    });

    await markDoneFn(reviewJob, 1);

    // Release SHOULD be finalized since no sibling is running
    const relRow = testDb.db
      .select({ finishedAt: schema.jobs.finishedAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, 'rel-2'))
      .get();
    expect(relRow?.finishedAt).not.toBeNull();
  });

  it('does not count a finished sibling step as "still running"', async () => {
    const now = Date.now() / 1000;
    // Test step is already finished
    testDb.db.insert(schema.jobs).values([
      makeJobRow({ id: 'rel-3', project: 'proj', kind: 'release', startedAt: now - 120 }) as any,
      makeJobRow({ id: 'test-3', project: 'proj', kind: 'test', startedAt: now - 60, finishedAt: now - 30, exitCode: 0 }) as any,
    ]).run();

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    const reviewJob = makeInMemoryJob('review-3', 'review', {
      startedAt: now - 25,
      releaseId: 'rel-3',
    });

    await markDoneFn(reviewJob, 1);

    // Finished sibling should NOT block finalization
    const relRow = testDb.db
      .select({ finishedAt: schema.jobs.finishedAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, 'rel-3'))
      .get();
    expect(relRow?.finishedAt).not.toBeNull();
  });
});

// ─── verdict retry rescue (lifecycle integration) ──────────────────────────

describe('verdict retry rescue', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let startFixFromJobMock: ReturnType<typeof vi.fn>;
  let retryVerdictMock: ReturnType<typeof vi.fn>;
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
      releaseId: 'release-retry',
      provider: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-retry-test-'));
    startFixFromJobMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-auto' });
    retryVerdictMock = vi.fn().mockResolvedValue(null);

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
        review_retry_on_parse_failure: true,
      }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: startFixFromJobMock,
    }));
    vi.doMock('@/lib/jobs/verdict-retry', () => ({
      retryVerdictWithClaude: retryVerdictMock,
    }));
    // Stub out the LGTM-path actions so they don't throw when retry succeeds
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: true, jobId: 'commit-1' }),
    }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({
      startMarkDod: vi.fn().mockResolvedValue({ ok: false }),
    }));

    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values(
      makeJobRow({ id: 'release-retry', project: 'proj', kind: 'release', startedAt: now - 120 }) as any
    ).run();
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('calls retryVerdictWithClaude when the review log has no parseable verdict', async () => {
    const logPath = join(tempDir, 'no-verdict.log');
    writeFileSync(logPath, 'The code looks fine overall. No major issues spotted.\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    await markDoneFn(makeReviewJob('rev-no-verdict', logPath), 0);

    expect(retryVerdictMock).toHaveBeenCalledOnce();
  });

  it('passes the source review provider into parse-retry for non-Claude reviews', async () => {
    const logPath = join(tempDir, 'no-verdict-codex.log');
    writeFileSync(logPath, 'Review text without a formal verdict line.\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    await markDoneFn(makeReviewJob('rev-no-verdict-codex', logPath, { provider: 'codex' }), 0);

    expect(retryVerdictMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rev-no-verdict-codex',
      provider: 'codex',
    }));
  });

  it('uses the rescued verdict from retry — LGTM → no fix started', async () => {
    retryVerdictMock.mockResolvedValue('LGTM');
    const logPath = join(tempDir, 'no-verdict-lgtm.log');
    writeFileSync(logPath, 'Everything looks good, tests pass.\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    await markDoneFn(makeReviewJob('rev-rescued-lgtm', logPath), 0);

    expect(retryVerdictMock).toHaveBeenCalledOnce();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('defaults to NEEDS ATTENTION when retry also returns null → fix is started', async () => {
    retryVerdictMock.mockResolvedValue(null);
    const logPath = join(tempDir, 'no-verdict-null.log');
    writeFileSync(logPath, 'Some concerns here but no verdict emitted.\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    await markDoneFn(makeReviewJob('rev-retry-null', logPath), 0);

    expect(retryVerdictMock).toHaveBeenCalledOnce();
    expect(startFixFromJobMock).toHaveBeenCalledWith('rev-retry-null');
  });

  it('swallows retryVerdictWithClaude throws — defaults to NEEDS ATTENTION and starts fix', async () => {
    retryVerdictMock.mockRejectedValue(new Error('spawn ENOENT'));
    const logPath = join(tempDir, 'no-verdict-throw.log');
    writeFileSync(logPath, 'Review text that has no verdict line.\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;

    // Must not throw even though retryVerdictWithClaude rejects
    await expect(markDoneFn(makeReviewJob('rev-retry-throw', logPath), 0)).resolves.not.toThrow();

    expect(retryVerdictMock).toHaveBeenCalledOnce();
    // After swallowed throw, rawVerdict is null → defaults to NEEDS ATTENTION → fix started
    expect(startFixFromJobMock).toHaveBeenCalledWith('rev-retry-throw');
  });
});

// ─── incremental review ref guard ────────────────────────────────────────────

describe('setReviewedRef incremental_review_enabled guard', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let setReviewedRefMock: ReturnType<typeof vi.fn>;
  let getCurrentBranchMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makeReviewJob(id: string, logPath: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind: 'review', prompt: null, pid: 0, logPath,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      releaseId: 'rel-inc', provider: null,
      ...overrides,
    };
  }

  function setupMocks(incrementalEnabled: boolean) {
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ deleteJob: vi.fn().mockResolvedValue(undefined), getJobStatus: vi.fn() }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
      setReviewedRef: setReviewedRefMock,
      getCurrentBranch: getCurrentBranchMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(), getLock: vi.fn().mockReturnValue(null), isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
        incremental_review_enabled: incrementalEnabled,
      }),
    }));
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-inc-ref-'));
    setReviewedRefMock = vi.fn().mockResolvedValue(undefined);
    getCurrentBranchMock = vi.fn().mockResolvedValue('main');
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');

    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values(
      makeJobRow({ id: 'rel-inc', project: 'proj', kind: 'release', startedAt: now - 60 }) as any
    ).run();
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT write reviewed ref when incremental_review_enabled is false', async () => {
    setupMocks(false);
    const logPath = join(tempDir, 'lgtm-off.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    await markDoneFn(makeReviewJob('rev-off', logPath), 0);

    expect(setReviewedRefMock).not.toHaveBeenCalled();
  });

  it('writes reviewed ref when incremental_review_enabled is true and project path resolves', async () => {
    setupMocks(true);
    const logPath = join(tempDir, 'lgtm-on.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    await markDoneFn(makeReviewJob('rev-on', logPath), 0);

    expect(setReviewedRefMock).toHaveBeenCalledWith('/path/to/proj', 'main');
  });

  it('does NOT write reviewed ref for LGTM PR reviews', async () => {
    setupMocks(true);
    const logPath = join(tempDir, 'lgtm-pr.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    await markDoneFn(
      makeReviewJob('rev-pr', logPath, {
        contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 7 }),
      }),
      0
    );

    expect(setReviewedRefMock).not.toHaveBeenCalled();
  });

  it('does NOT write reviewed ref for non-LGTM verdicts', async () => {
    setupMocks(true);
    const logPath = join(tempDir, 'needs-attn.log');
    writeFileSync(logPath, 'Findings:\n- Finding ID: x\n  Severity: low\nVerdict: NEEDS ATTENTION\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    await markDoneFn(makeReviewJob('rev-na', logPath), 0);

    expect(setReviewedRefMock).not.toHaveBeenCalled();
  });
});

describe('review completion preserves the git index', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let execMock: ReturnType<typeof vi.fn>;
  let markReviewedMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makeReviewJob(id: string, logPath: string, overrides: Partial<JobData> = {}): JobData {
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
      provider: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-review-index-'));
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    markReviewedMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: markReviewedMock,
      setReviewedRef: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
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
      releaseLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      runAutoChainGates: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0,
        fix_ci_retry_window_seconds: 120,
        fix_ci_fast_crash_ms: 5000,
        incremental_review_enabled: false,
        review_retry_on_parse_failure: false,
      }),
    }));
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not stage files after a successful standalone review', async () => {
    const logPath = join(tempDir, 'standalone.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    await markDoneFn(makeReviewJob('review-standalone', logPath), 0);

    expect(markReviewedMock).toHaveBeenCalledWith('proj', '/path/to/proj');
    expect(execMock.mock.calls.some((call) => call[0] === 'git' && call[1][2] === 'add')).toBe(false);
  });

  it('does not stage files after a successful PR review', async () => {
    const logPath = join(tempDir, 'pr-review.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    await markDoneFn(
      makeReviewJob('review-pr', logPath, {
        contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 7 }),
      }),
      0
    );

    expect(markReviewedMock).not.toHaveBeenCalled();
    expect(execMock.mock.calls.some((call) => call[0] === 'git' && call[1][2] === 'add')).toBe(false);
  });
});

// ─── auto-mark seen on completion ────────────────────────────────────────────

describe('auto-mark seen on completion', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let finalizeAgentRunReportMock: ReturnType<typeof vi.fn>;

  function makeInMemoryJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind, prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    finalizeAgentRunReportMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: false, autoCommitEnabled: false,
        releaseAfterRun: false, prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(), getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
      }),
    }));
    // finalizeAgentRunReport would otherwise overwrite job.modifiedFiles based
    // on git/log inspection. The auto-mark logic depends on the value present
    // at lifecycle time, so leave whatever the test set.
    vi.doMock('@/lib/agents/agent-run-report', () => ({
      finalizeAgentRunReport: finalizeAgentRunReportMock,
    }));
  });

  afterEach(() => vi.resetModules());

  async function runMarkDone(job: JobData, exitCode: number): Promise<boolean> {
    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    await markDoneFn(job, exitCode);
    const row = testDb.db
      .select({ seen: schema.jobs.seen })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id))
      .get();
    return !!row?.seen;
  }

  it('auto-marks a successful pipeline child seen (commit / push / test)', async () => {
    for (const kind of ['commit', 'push', 'test', 'fix-push', 'mark-dod']) {
      const seen = await runMarkDone(makeInMemoryJob(`${kind}-ok`, kind), 0);
      expect(seen, `${kind} exit-0 should be auto-seen`).toBe(true);
      vi.resetModules();
    }
  });

  it('does NOT auto-mark a failed pipeline child seen', async () => {
    const seen = await runMarkDone(makeInMemoryJob('test-fail', 'test'), 1);
    expect(seen).toBe(false);
  });

  it('does NOT auto-mark a release meta-job seen even on success', async () => {
    const seen = await runMarkDone(makeInMemoryJob('rel-ok', 'release'), 0);
    expect(seen).toBe(false);
  });

  it('does NOT auto-mark interactive `run` jobs seen', async () => {
    const seen = await runMarkDone(makeInMemoryJob('term-ok', 'run'), 0);
    expect(seen).toBe(false);
  });

  it('auto-marks an LGTM review seen but leaves NEEDS ATTENTION unseen', async () => {
    const lgtmLog = join(mkdtempSync(join(tmpdir(), 'amark-')), 'lgtm.log');
    writeFileSync(lgtmLog, 'Findings: none\nVerdict: LGTM\n');
    const seenLgtm = await runMarkDone(makeInMemoryJob('rev-lgtm', 'review', { logPath: lgtmLog }), 0);
    expect(seenLgtm).toBe(true);

    vi.resetModules();
    const naLog = join(mkdtempSync(join(tmpdir(), 'amark-')), 'na.log');
    writeFileSync(naLog, 'Findings:\n- Finding ID: x\nVerdict: NEEDS ATTENTION\n');
    const seenNa = await runMarkDone(makeInMemoryJob('rev-na', 'review', { logPath: naLog }), 0);
    expect(seenNa).toBe(false);
  });

  it('auto-marks a no-op agent run (empty modifiedFiles) seen but keeps actionable runs unseen', async () => {
    const seenNoop = await runMarkDone(
      makeInMemoryJob('agent-noop', 'agent:improve', { modifiedFiles: '[]' }),
      0,
    );
    expect(seenNoop).toBe(true);

    vi.resetModules();
    const seenActionable = await runMarkDone(
      makeInMemoryJob('agent-act', 'agent:improve', { modifiedFiles: '[{"path":"a.ts"}]' }),
      0,
    );
    expect(seenActionable).toBe(false);
  });

  it('keeps an agent run unseen when report extraction fails and modifiedFiles is missing', async () => {
    finalizeAgentRunReportMock.mockRejectedValueOnce(new Error('git status failed'));
    const seen = await runMarkDone(
      makeInMemoryJob('agent-report-fail', 'agent:improve', { modifiedFiles: null }),
      0,
    );
    expect(seen).toBe(false);
  });
});

describe('fix-push cap notifications', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let notifyMock: ReturnType<typeof vi.fn>;
  let startFixPushMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  function makePushJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind: 'push',
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
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-fix-push-cap-'));
    notifyMock = vi.fn().mockResolvedValue(undefined);
    startFixPushMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'fix-push-next' });

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
        autoPrMergeEnabled: false,
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
      notify: notifyMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0,
        fix_ci_retry_window_seconds: 120,
        fix_ci_fast_crash_ms: 5000,
      }),
    }));
    vi.doMock('@/lib/pipeline/start-fix-push', () => ({
      isHookRejection: vi.fn().mockReturnValue(true),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      startFixPush: startFixPushMock,
    }));
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits fix_loop_exhausted when push hook retries hit the fix-push cap', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release.log');
    const pushLog = join(tempDir, 'push.log');
    writeFileSync(releaseLog, '# release start\n');
    writeFileSync(pushLog, 'husky - pre-push hook exited with code 1\n');

    testDb.db.insert(schema.jobs).values([
      makeJobRow({
        id: 'release-fix-push-cap',
        project: 'proj',
        kind: 'release',
        logPath: releaseLog,
        startedAt: now - 300,
      }) as any,
      makeJobRow({
        id: 'fix-push-old-1',
        project: 'proj',
        kind: 'fix-push',
        startedAt: now - 120,
        finishedAt: now - 110,
        exitCode: 0,
      }) as any,
      makeJobRow({
        id: 'fix-push-old-2',
        project: 'proj',
        kind: 'fix-push',
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }) as any,
    ]).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    markDoneFn = markDone;

    const pushJob = makePushJob('push-cap-hit', {
      logPath: pushLog,
      releaseId: 'release-fix-push-cap',
      startedAt: now - 10,
    });

    await markDoneFn(pushJob, 1);

    expect(startFixPushMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      event: 'fix_loop_exhausted',
      project: 'proj',
      job_id: 'push-cap-hit',
      status: 'failed',
    }));

    const releaseRow = testDb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, 'release-fix-push-cap'))
      .get();
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.contextMeta).toContain('"releaseStopReason":"fix-push cap reached for proj');
    expect(readFileSync(releaseLog, 'utf8')).toContain('fix-push cap reached for proj');
  });
});

// ─── agent drain hook ─────────────────────────────────────────────────────────

describe('agent drain hook', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let drainNextAgentRunMock: ReturnType<typeof vi.fn>;

  function makeAgentJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind, prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    drainNextAgentRunMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: false, autoCommitEnabled: false,
        releaseAfterRun: false, prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(), getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
      }),
    }));
    vi.doMock('@/lib/agents/agent-run-report', () => ({
      finalizeAgentRunReport: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/agents/pending-agent-run', () => ({
      drainNextAgentRun: drainNextAgentRunMock,
    }));
  });

  afterEach(() => vi.resetModules());

  it('calls drainNextAgentRun with the project when an agent job finishes', async () => {
    const job = makeAgentJob('agent-done', 'agent:improve');
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 0);

    expect(drainNextAgentRunMock).toHaveBeenCalledOnce();
    expect(drainNextAgentRunMock).toHaveBeenCalledWith('proj');
  });

  it('calls drainNextAgentRun even when the agent job fails', async () => {
    const job = makeAgentJob('agent-fail-drain', 'agent:tests');
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 1);

    expect(drainNextAgentRunMock).toHaveBeenCalledOnce();
    expect(drainNextAgentRunMock).toHaveBeenCalledWith('proj');
  });

  it('does NOT call drainNextAgentRun for non-agent jobs', async () => {
    const job = makeAgentJob('push-done', 'push');
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 0);

    expect(drainNextAgentRunMock).not.toHaveBeenCalled();
  });
});

// ─── agent run failure notification ──────────────────────────────────────────

describe('agent run failure notification', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let notifyMock: ReturnType<typeof vi.fn>;

  function makeAgentJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind, prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    notifyMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: false, autoCommitEnabled: false,
        releaseAfterRun: false, prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(), getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: notifyMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
      }),
    }));
    vi.doMock('@/lib/agents/agent-run-report', () => ({
      finalizeAgentRunReport: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/agents/pending-agent-run', () => ({
      drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => vi.resetModules());

  it('emits agent_run_fail notification when an agent job exits non-zero', async () => {
    const job = makeAgentJob('agent-fail', 'agent:my-agent');
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 1);

    const call = notifyMock.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({
      event: 'agent_run_fail',
      project: 'proj',
      agent: 'my-agent',
      job_id: 'agent-fail',
      status: 'failed',
    });
  });

  it('does NOT emit agent_run_fail when the agent job succeeds', async () => {
    const job = makeAgentJob('agent-ok', 'agent:improve');
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 0);

    const failCall = notifyMock.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(failCall).toBeUndefined();
  });

  it('does NOT emit agent_run_fail for non-agent job failures', async () => {
    const job = makeAgentJob('test-fail', 'test');
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 1);

    const failCall = notifyMock.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(failCall).toBeUndefined();
  });
});

// ─── orphan release lock release ─────────────────────────────────────────────

describe('orphan release lock release', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let releaseLockMock: ReturnType<typeof vi.fn>;

  function makeReleaseJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind: 'release', prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    releaseLockMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: false, autoCommitEnabled: false,
        releaseAfterRun: false, prWorkflowEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: releaseLockMock,
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
      }),
    }));
    vi.doMock('@/lib/agents/agent-run-report', () => ({
      finalizeAgentRunReport: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => vi.resetModules());

  it('calls releaseLock with project and jobId when a release job completes', async () => {
    const job = makeReleaseJob('release-orphan');
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 0);

    expect(releaseLockMock).toHaveBeenCalledWith('proj', 'release-orphan');
  });

  it('does NOT call releaseLock for interactive run jobs', async () => {
    const job = makeReleaseJob('run-job-1', { kind: 'run' });
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 0);

    // Neither the pipeline-step path nor the release-kind guard applies to `run` jobs
    expect(releaseLockMock).not.toHaveBeenCalled();
  });
});

// ─── push → dod target selection ─────────────────────────────────────────────

describe('push → dod target selection', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let startMarkDodMock: ReturnType<typeof vi.fn>;
  let launchPrWaitMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;

  const prContextMeta = JSON.stringify({ prNumber: 42, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/42' });

  function makePushJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind: 'push', prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    startMarkDodMock = vi.fn().mockResolvedValue({ ok: true, verified: 1, total: 1, changed: false });
    launchPrWaitMock = vi.fn().mockReturnValue({ jobId: 'pr-wait-job' });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      deleteJob: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: false, autoCommitEnabled: false,
        releaseAfterRun: false, prWorkflowEnabled: false,
        autoPrMergeEnabled: false,
      }),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      releaseLock: vi.fn(),
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({ pruneProjectLogs: vi.fn() }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
      }),
    }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
    vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ launchPrWait: launchPrWaitMock }));
    vi.doMock('@/lib/agents/agent-run-report', () => ({
      finalizeAgentRunReport: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
  });

  afterEach(() => vi.resetModules());

  it('uses issue target when ghIssueNumber and ghIssueRepo are set', async () => {
    const job = makePushJob('push-issue-dod', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    await markDoneFn(job, 0);

    expect(startMarkDodMock).toHaveBeenCalledWith('proj', { issueNumber: 7, repo: 'owner/repo', mode: 'pipeline' });
  });

  it('falls back to PR target when ghIssueNumber is null', async () => {
    const job = makePushJob('push-pr-dod', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: null,
      ghIssueRepo: null,
    });
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    await markDoneFn(job, 0);

    expect(startMarkDodMock).toHaveBeenCalledWith('proj', { prNumber: 42, repo: 'owner/repo', mode: 'pipeline' });
  });

  it('skips dod entirely when contextMeta has no prNumber', async () => {
    const job = makePushJob('push-no-meta-dod', {
      exitCode: 0,
      contextMeta: JSON.stringify({ message: 'pushed ok' }),
    });
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    await markDoneFn(job, 0);

    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('launches pr-wait and skips dod when autoPrMergeEnabled is true', async () => {
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({
        autoPushEnabled: false, autoCommitEnabled: false,
        releaseAfterRun: false, prWorkflowEnabled: false,
        autoPrMergeEnabled: true,
      }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    const job = makePushJob('push-auto-merge', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    testDb.db.insert(schema.jobs).values(makeJobRow({ id: job.id, project: job.project, kind: job.kind })).run();

    await mod.markDone(job, 0);

    expect(launchPrWaitMock).toHaveBeenCalledWith('proj', 42, 'owner/repo', 'https://github.com/owner/repo/pull/42');
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });
});
