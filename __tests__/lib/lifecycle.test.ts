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
      verdict TEXT,
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
      makeJobRow({ id: 'test-gap', project: 'proj', kind: 'test', startedAt: now - 190, finishedAt: now - 130, exitCode: 0 }) as any,
      // review starts 80 seconds after test finished (now-130 + 80 = now-50) — gap > 60s → excluded
      makeJobRow({ id: 'review-gap', project: 'proj', kind: 'review', startedAt: now - 50, finishedAt: now - 20, exitCode: 0 }) as any,
    ]).run();

    const { reconcileStaleRelease: fn } = await import('@/lib/jobs/job-storage');

    // Trigger via the review job finishing (it's within its own chain, but not the release's)
    const reviewJob = makeJob('review', { project: 'proj', finishedAt: now - 20, exitCode: 0 });
    await fn(reviewJob);

    const row = testDb.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'release-gap')).get();
    // The chain should include only the test step; the review is too far away.
    // Release is finalized because test finished long ago (now-130, well past the 5s grace).
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0); // only the test step (exit 0) is in the chain
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

  function makeReviewJob(id: string, logPath: string | null): JobData {
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
});
