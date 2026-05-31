import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql, type InferInsertModel } from 'drizzle-orm';
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
      lines_added integer,
      lines_removed integer,
      provider text,
      run_score integer
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
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project text PRIMARY KEY,
      repo text NOT NULL,
      prs text NOT NULL DEFAULT '[]',
      issues text NOT NULL DEFAULT '[]',
      fetched_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS job_completion_events (
      id serial PRIMARY KEY,
      job_id text NOT NULL,
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
    CREATE UNIQUE INDEX IF NOT EXISTS job_completion_events_job_id
    ON job_completion_events (job_id)
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

async function flushDbQueue(): Promise<void> {
  // Fire-and-forget writes in job storage are serialized by PGlite, so a
  // no-op query drains anything already queued without polling.
  await sharedHandle.db.execute(sql.raw('SELECT 1'));
}

type JobInsert = InferInsertModel<typeof schema.jobs>;

// Getter shim so existing `testDb.db.*` test code keeps working while the
// underlying connection is the shared PGlite handle.
const testDb = {
  get db() {
    return sharedHandle.db;
  },
} as { db: TestDbHandle['db'] };

function toCachedJob(row: JobInsert): JobData {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind,
    prompt: row.prompt ?? null,
    pid: row.pid,
    logPath: row.logPath ?? null,
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
    releaseDeadlineAt: row.releaseDeadlineAt ?? null,
    promptBytes: row.promptBytes ?? null,
    workSummary: row.workSummary ?? null,
    modifiedFiles: row.modifiedFiles ?? null,
    linesAdded: row.linesAdded ?? null,
    linesRemoved: row.linesRemoved ?? null,
    provider: row.provider ?? null,
  };
}

async function insertJobsAndSync(rows: JobInsert | JobInsert[]): Promise<void> {
  const batch = Array.isArray(rows) ? rows : [rows];
  await sharedHandle.db.insert(schema.jobs).values(batch);
  const { jobsCache } = await import('@/lib/jobs/storage');
  for (const row of batch) {
    jobsCache.set(row.id, toCachedJob(row));
  }
}

// Skipped: the release-linked legacy chain that drove fix→review fires
// only for non-workflow-driven jobs now. The orchestrator + applyReleaseGuards
// own this for release-linked jobs. See:
//   __tests__/lib/workflows/decide-next-phase.test.ts (fix → re-verify routing)
//   __tests__/lib/workflows/release-orchestrator.test.ts (integration)
//   __tests__/lib/workflows/guards/* (convergence + iteration caps)
describe.skip('runCompletionHooks – fix→review auto-trigger', () => {
  // Hoist mocks + module imports to `beforeAll`; reset stable mock refs in
  // `beforeEach` to avoid the per-test `vi.resetModules() + await import(...)`
  // re-execution cost.
  const startProjectReviewMock = vi.fn();
  const getJobStatusMock = vi.fn();
  const deleteJobMock = vi.fn();
  const execMock = vi.fn();
  const markReviewedMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  let storageCache: Map<string, JobData>;

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

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: markReviewedMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 999, logPath: '/tmp/rev.log' });
    getJobStatusMock.mockReset();
    deleteJobMock.mockReset().mockResolvedValue(undefined);
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    markReviewedMock.mockReset().mockResolvedValue(undefined);
    resolveProjectPathMock.mockReset().mockReturnValue(null);
    getProjectTestConfigMock.mockReset().mockReturnValue({
      testCommand: null,
      testCronEnabled: false,
      testCronSchedule: null,
      autoPushEnabled: true,
    });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/scheduling/scheduling');
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
// Skipped: release-linked chain semantics now in the orchestrator. Relevant
// new coverage: __tests__/lib/workflows/release-orchestrator.test.ts +
// the dispatch-phase / decide-next-phase / phases/*-phase test suites.
describe.skip('runCompletionHooks – auto-push pipeline', () => {
  // Hoist mocks + module imports to `beforeAll`; reset stable mock refs in
  // `beforeEach` to avoid the per-test `vi.resetModules() + await import(...)`
  // re-execution cost across 42 tests.
  const startProjectTestMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startProjectReviewMock = vi.fn();
  const startFixFromJobMock = vi.fn();
  const startReleaseMock = vi.fn();
  const setPendingReleaseMock = vi.fn();
  const shouldKeepPendingReleaseMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  const execMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  const isReviewedMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
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

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
      isReviewed: isReviewedMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/pipeline/start-release', () => ({ startRelease: startReleaseMock }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: setPendingReleaseMock,
      shouldKeepPendingRelease: shouldKeepPendingReleaseMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    // Module-level verdict cache survives across tests when the module is not
    // reloaded per-test; clear it in beforeEach so stale review entries
    // (e.g. 'review-job' → 'LGTM' from a prior test) don't poison getVerdict.
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-autopush-test-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();

    startProjectTestMock.mockReset().mockResolvedValue({ ok: true, jobId: 'test-auto', pid: 999, logPath: '/tmp/t.log', testCmd: 'pnpm test' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'pushed' });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'committed' });
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 1, logPath: '' });
    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-auto', pid: 2 });
    startReleaseMock.mockReset().mockResolvedValue({ ok: true, jobId: 'release-auto', releaseJobId: 'release-auto', step: 'test', message: 'running' });
    setPendingReleaseMock.mockReset();
    shouldKeepPendingReleaseMock.mockReset().mockReturnValue(false);
    getProjectTestConfigMock.mockReset().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: true });
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    resolveProjectPathMock.mockReset().mockReturnValue('/proj');
    isReviewedMock.mockReset().mockResolvedValue(false);
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-test');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.resetModules();
  });

  it('finalizes active release job with exit 0 when push succeeds', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'release-job-push', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as JobInsert);

    const job = makeJob('push', null, { releaseId: 'release-job-push' });
    await markDoneFn(job, 0);

    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-job-push');
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.exitCode).toBe(0);
  });

  it('finalizes active release job with exit 1 when push fails', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'release-job-push-fail', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as JobInsert);

    const job = makeJob('push', null, { releaseId: 'release-job-push-fail' });
    await markDoneFn(job, 1);

    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-job-push-fail');
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.exitCode).toBe(1);
  });

  it('skips finalization when DB row already has finishedAt set (concurrent probe guard)', async () => {
    const now = Date.now() / 1000;
    // Simulate a job that a concurrent probe already finalized in the DB,
    // but whose in-memory JobData still has finishedAt === null.
    await testDb.db.insert(schema.jobs).values({
      id: 'run-job', project: 'my-proj', kind: 'run',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: now - 1, exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

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
    await testDb.db.insert(schema.jobs).values({
      id: 'release-job-already-done', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 20, finishedAt: now - 5, exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('push', null);
    await markDoneFn(job, 0);

    // Already-done release job should not be re-finalized (finishedAt stays the same)
    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-job-already-done');
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
      await testDb.db
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
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
        } as any);
    }
    const job = makeJob('test', null);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('starts fix when test fails during an active release (inRelease=true)', async () => {
    // Neither auto flag is set, but there's an active release job — should still fix.
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoPushEnabled: false, autoCommitEnabled: false });
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'active-release-for-testfail', project: 'my-proj', kind: 'release',
      prompt: null, pid: 1, logPath: null,
      startedAt: now - 10, finishedAt: null, exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as JobInsert);
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
    await insertJobsAndSync({
      id: 'fresh-lgtm-review',
      project: 'my-proj',
      kind: 'review',
      prompt: null,
      pid: 777,
      logPath: join(tempDir, 'fresh-lgtm-review.log'),
      startedAt: now - 60,
      finishedAt: now - 10,
      exitCode: 0,
      seen: true,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as JobInsert);
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
    await testDb.db.insert(schema.jobs).values({
      id: 'stale-lgtm-review',
      project: 'my-proj',
      kind: 'review',
      prompt: null,
      pid: 777,
      logPath: join(tempDir, 'stale-lgtm-review.log'),
      startedAt: now - 60,
      finishedAt: now - 10,
      exitCode: 0,
      seen: true,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any);
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
      await testDb.db
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
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
        } as any);
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
    await testDb.db.insert(schema.jobs).values({
      id: 'release-cap',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
      startedAt: now - 300,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as any);
    for (let i = 0; i < 3; i++) {
      await testDb.db.insert(schema.jobs).values({
        id: `release-cap-fix-${i}`,
        project: 'my-proj',
        kind: 'fix',
        prompt: null,
        pid: 500 + i,
        logPath: null,
        startedAt: now - 240 + i,
        finishedAt: now - 230 + i,
        exitCode: 0,
        seen: true,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        releaseId: 'release-cap',
      } as any);
    }

    const logFile = join(tempDir, 'review-cap.log');
    writeFileSync(logFile, 'Findings:\n- Finding ID: still-broken\n  Root cause: server bypass\nVerdict: DO NOT SHIP\n');
    const job = makeJob('review', logFile, { id: 'review-cap-final', releaseId: 'release-cap' });

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
    // Release stays open — the trailing fix continues; the cap fires on the
    // next review (fix→review hook), not here.
    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-cap');
    expect(releaseRow?.finishedAt).toBeNull();
  });

  it('starts fix on NEEDS ATTENTION even with prior fixes in the same release (fixes are unbounded)', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      await testDb.db
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
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
          releaseId: 'release-current',
        } as any);
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
      await testDb.db
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
          seen: true,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
          sessionId: null,
          releaseId: 'release-previous',
        } as any);
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

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not retry when the max retry count has been exceeded', async () => {
      // Insert 3 prior fix-ci jobs so the count gate trips.
      const now = Date.now() / 1000;
      await insertJobsAndSync(Array.from({ length: 3 }, (_, i) => ({
          id: `prior-fixci-${i}`, project: 'my-proj', kind: 'fix-ci',
          prompt: null, pid: 200 + i, logPath: null,
          startedAt: now - i, finishedAt: now - i + 1, exitCode: -1,
          seen: true, durationMs: null, inputTokens: null, outputTokens: null,
          cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
        } as JobInsert)));

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

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});
describe('markDone – isClaudeKind exit-code override for new kinds', () => {
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
  let tempDir: string;
  let jobSeq = 0;
  const startReleaseMock = vi.fn();
  const setPendingReleaseMock = vi.fn();
  const shouldKeepPendingReleaseMock = vi.fn();
  const finalizeAgentRunReportMock = vi.fn();

  function makeJob(kind: string, logPath: string | null): JobData {
    return {
      id: `${kind.replace(':', '-')}-override-test-${++jobSeq}`,
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

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
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
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: startReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: setPendingReleaseMock,
      shouldKeepPendingRelease: shouldKeepPendingReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/agents/agent-run-report', () => ({
      finalizeAgentRunReport: finalizeAgentRunReportMock,
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-isclaudekind-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    startReleaseMock.mockReset().mockResolvedValue({ ok: true, jobId: 'release-1', releaseJobId: 'release-1', step: 'test', message: 'running' });
    setPendingReleaseMock.mockReset();
    shouldKeepPendingReleaseMock.mockReset().mockReturnValue(false);
    finalizeAgentRunReportMock.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/agents/agent-run-report');
    vi.resetModules();
  });

  it.each(['fix', 'fix-ci', 'agent:my-agent'])(
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

  it.each(['run', 'review', 'fix-ci', 'agent:my-agent'])(
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
// Skipped: rewritten earlier this session for the unified-fix collapse, but
// these test the legacy chain on release-linked push jobs which now
// short-circuit. The orchestrator's dispatch path covers the same flow:
//   __tests__/lib/workflows/release-orchestrator.test.ts
//   __tests__/lib/workflows/dispatch-phase.test.ts (next=fix from push)
//   __tests__/lib/workflows/guards/iteration-caps.test.ts (push fix cap)
describe.skip('runCompletionHooks – push-fix auto-recovery (unified fix)', () => {
  // After fix-push collapsed into the generic fix kind, push hook rejections
  // spawn `startFixFromJob(pushJobId)` (a fix kind with parentJobId pointing
  // at the push). The cap is counted on fix jobs whose parent is a push.
  // The fix→push re-attempt now flows through the parent-aware fix-success
  // branch in lifecycle.ts (re-runs push directly).
  const startFixFromJobMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startProjectReviewMock = vi.fn();
  const isHookRejectionMock = vi.fn();
  const isTestFailureRejectionMock = vi.fn();
  const isRemoteRaceRejectionMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  const execMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
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

  async function insertActiveRelease() {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'active-release-job',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: now - 5,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    } as JobInsert);
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: isHookRejectionMock,
      isTestFailureRejection: isTestFailureRejectionMock,
      isRemoteRaceRejection: isRemoteRaceRejectionMock,
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-pushfix-chain-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();

    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-from-push-1', pid: 999 });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'pushed' });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'committed' });
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-1', pid: 888, logPath: '/tmp/rev.log' });
    isHookRejectionMock.mockReset().mockReturnValue(false);
    isTestFailureRejectionMock.mockReset().mockReturnValue(false);
    isRemoteRaceRejectionMock.mockReset().mockReturnValue(false);
    getProjectTestConfigMock.mockReset().mockReturnValue({ autoPushEnabled: false });
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    resolveProjectPathMock.mockReset().mockReturnValue('/proj');
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.resetModules();
  });

  it('spawns startFixFromJob(pushId) when push fails with a hook rejection', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const logFile = join(tempDir, 'push-hook-fail.log');
    writeFileSync(logFile, 'husky - pre-commit hook exited with code 1');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(isHookRejectionMock).toHaveBeenCalled();
    expect(startFixFromJobMock).toHaveBeenCalledWith(job.id);
  });

  it('does not spawn fix when push fails for a non-hook reason', async () => {
    isHookRejectionMock.mockReturnValue(false);
    const logFile = join(tempDir, 'push-network-fail.log');
    writeFileSync(logFile, 'error: failed to push some refs to origin');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix when push fails because pre-push tests broke', async () => {
    // Hook rejection is true (husky pre-push failed) but it's a test failure,
    // not a lint nit — we don't want to enter the fix retry loop because
    // Claude can't reliably "fix" flaky integration tests.
    isHookRejectionMock.mockReturnValue(true);
    isTestFailureRejectionMock.mockReturnValue(true);
    const logFile = join(tempDir, 'push-tests-fail.log');
    writeFileSync(logFile, 'husky - pre-push script failed (code 1)\n FAIL  src/foo.test.ts\n Tests  1 failed | 100 passed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(isTestFailureRejectionMock).toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix when push succeeds', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const job = makeJob('push', null);

    await markDoneFn(job, 0);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not spawn fix when the push-fix attempt cap (2) has been reached', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const now = Date.now() / 1000;
    // Two prior failed pushes, each with a fix-from-push child.
    const priorRows: JobInsert[] = [];
    for (let i = 0; i < 2; i++) {
      priorRows.push({
        id: `prior-push-${i}`,
        project: 'my-proj',
        kind: 'push',
        prompt: null,
        pid: 50 + i,
        logPath: null,
        startedAt: now - i * 20 - 10,
        finishedAt: now - i * 20 - 8,
        exitCode: 1,
        seen: true,
      } as JobInsert);
      priorRows.push({
        id: `prior-fix-${i}`,
        project: 'my-proj',
        kind: 'fix',
        parentJobId: `prior-push-${i}`,
        prompt: null,
        pid: 100 + i,
        logPath: null,
        startedAt: now - i * 10,
        finishedAt: now - i * 10 + 5,
        exitCode: 0,
        seen: true,
      } as JobInsert);
    }
    await insertJobsAndSync(priorRows);
    const logFile = join(tempDir, 'push-hook-capped.log');
    writeFileSync(logFile, 'pre-commit failed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('still spawns fix when only 1 prior attempt exists (cap is 2)', async () => {
    isHookRejectionMock.mockReturnValue(true);
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'prior-push-0',
      project: 'my-proj',
      kind: 'push',
      prompt: null,
      pid: 50,
      logPath: null,
      startedAt: now - 30,
      finishedAt: now - 28,
      exitCode: 1,
      seen: true,
    } as JobInsert);
    await insertJobsAndSync({
      id: 'prior-fix-0',
      project: 'my-proj',
      kind: 'fix',
      parentJobId: 'prior-push-0',
      prompt: null,
      pid: 100,
      logPath: null,
      startedAt: now - 10,
      finishedAt: now - 5,
      exitCode: 0,
      seen: true,
    } as JobInsert);
    const logFile = join(tempDir, 'push-hook-one-prior.log');
    writeFileSync(logFile, 'pre-commit failed');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 1);

    expect(startFixFromJobMock).toHaveBeenCalledTimes(1);
  });

  it('chains review LGTM → commit when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    await insertActiveRelease();
    const logFile = join(tempDir, 'lgtm-release.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    const job = makeJob('review', logFile, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectCommitMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectPushMock).not.toHaveBeenCalled();
  });

  it('chains test pass → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    await insertActiveRelease();
    // Provide uncommitted changes so the hook routes to review rather than push.
    execMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'M foo.ts\n', stderr: '' });
    const job = makeJob('test', null, { releaseId: 'active-release-job' });

    await markDoneFn(job, 0);

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj');
  });

  it('chains fix success → review when inRelease even though auto-push is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false });
    await insertActiveRelease();
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
  // Hoist mocks + module import once. Stable refs let beforeEach mockReset()
  // without paying for a per-test module reload. The 2 outlier tests
  // (`releaseAfterRun: null`, `schedulingModuleThrows: true`) opt into a
  // reload via `loadMarkDone(...)`; everything else uses the fast path.
  const startReleaseMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  const setPendingReleaseMock = vi.fn();
  const shouldKeepPendingReleaseMock = vi.fn();
  const execMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
  let jobSeq = 0;
  // Outlier tests that call `loadMarkDone(...)` swap in a non-default module
  // factory (e.g. scheduling throws on import). Subsequent default tests must
  // reload to get back to a clean import graph; we cheap-track that here.
  let dirty = false;

  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind.replace(':', '-')}-rar-test-${++jobSeq}`,
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

  function resetMocksToDefaults(releaseAfterRun: boolean | null = true): void {
    startReleaseMock.mockReset().mockResolvedValue({ ok: true, step: 'review', jobId: 'rel-1', releaseJobId: 'rel-job-1', message: 'Running review' });
    getProjectTestConfigMock.mockReset().mockReturnValue(
      releaseAfterRun === null
        ? null
        : { autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun }
    );
    setPendingReleaseMock.mockReset();
    shouldKeepPendingReleaseMock.mockReset().mockReturnValue(false);
    execMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  }

  // Slow path: only the 2 tests that exercise a different module-load shape
  // (no scheduling config row, or scheduling module throws on import) need
  // this — they reload the job-storage module with a different mock factory.
  async function loadMarkDone({
    releaseAfterRun = true,
    schedulingModuleThrows = false,
  }: {
    releaseAfterRun?: boolean | null;
    schedulingModuleThrows?: boolean;
  } = {}) {
    // Mark dirty whenever a non-default factory shape is requested so the
    // next default `beforeEach` knows it must reload the module rather than
    // just mockReset()-ing.
    dirty = releaseAfterRun !== true || schedulingModuleThrows;
    vi.resetModules();
    resetMocksToDefaults(releaseAfterRun);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
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
    // The release-after-run hook now goes through the workflow runtime
    // (`dispatchReleaseWorkflow` → `start(releaseWorkflow, ...)`). Mock the
    // workflow dispatch helper to keep these tests pure (no real workflow
    // runtime spin-up). The legacy `start-release` mock stays in place too
    // for any path that still calls it directly.
    vi.doMock('@/lib/workflows/dispatch-release', () => ({
      dispatchReleaseWorkflow: (project: string, opts: unknown) => startReleaseMock(project, opts),
    }));
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
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'not needed' }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
  }

  beforeAll(async () => {
    await loadMarkDone();
    dirty = false;
  });

  beforeEach(async () => {
    if (dirty) {
      await loadMarkDone();
      dirty = false;
      return;
    }
    storageCache.clear();
    resetVerdictCache();
    resetMocksToDefaults();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.resetModules();
  });

  it('triggers startRelease after run job finishes with exit 0 when releaseAfterRun=true', async () => {
    const job = makeJob('run');
    await markDoneFn(job, 0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: job.id,
    });
  });

  it('skips startRelease after agent:x when finalize left no changed files (idle-cycle)', async () => {
    // markDone runs finalizeAgentRunReport before the release-after-run
    // hook, which reads the worktree via the mocked git exec. With the
    // default empty-stdout mock the agent has produced nothing, and the
    // new shippable-change gate must skip the release dispatch. Without
    // this gate the legacy behavior fired an empty release every cycle.
    const job = makeJob('agent:my-agent');
    await markDoneFn(job, 0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('skips startRelease after agent:x when finalize only saw dirty-baseline files', async () => {
    // Realistic case: agent did NOT commit (BASE..HEAD empty), the only
    // file in the worktree was the same one already dirty in the baseline.
    // Per-file attribution marks it low confidence; the gate then skips
    // the release-after-run dispatch.
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/pre-existing.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '99\t12\tsrc/pre-existing.ts\n', stderr: '' });
    const job = makeJob('agent:my-agent', {
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'my-agent', schedule: '15m', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', dirty: true, status: ' M src/pre-existing.ts\n' },
      }),
    });

    await markDoneFn(job, 0);

    expect(job.modifiedFiles).toBe(JSON.stringify([
      { path: 'src/pre-existing.ts', status: 'M', confidence: 'low' },
    ]));
    expect(job.linesAdded).toBe(0);
    expect(job.linesRemoved).toBe(0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('skips startRelease after agent:x when dirty-baseline run only sees an unrelated commit', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/unrelated-commit.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '13\t4\tsrc/unrelated-commit.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const job = makeJob('agent:my-agent', {
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'my-agent', schedule: '15m', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', dirty: true, status: ' M src/pre-existing.ts\n' },
      }),
    });

    await markDoneFn(job, 0);

    expect(job.modifiedFiles).toBe(JSON.stringify([
      { path: 'src/unrelated-commit.ts', status: 'M', confidence: 'low' },
    ]));
    expect(job.linesAdded).toBe(0);
    expect(job.linesRemoved).toBe(0);
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('triggers startRelease after agent:x adds a NEW file even on a dirty baseline', async () => {
    // The autonomy fix: a stale dirty file in the worktree must not prevent
    // the orchestrator from releasing changes the agent legitimately made
    // on top of it. Per-file attribution marks the new file high confidence;
    // the gate accepts it; release dispatches.
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: ' M src/pre-existing.ts\n?? src/new-from-agent.md\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '99\t12\tsrc/pre-existing.ts\n8\t0\tsrc/new-from-agent.md\n',
        stderr: '',
      });
    const job = makeJob('agent:my-agent', {
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'my-agent', schedule: '15m', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', dirty: true, status: ' M src/pre-existing.ts\n' },
      }),
    });

    await markDoneFn(job, 0);

    // The new file lands as high-confidence; pre-existing stays low.
    const files = JSON.parse(job.modifiedFiles ?? '[]') as Array<Record<string, unknown>>;
    expect(files).toContainEqual({ path: 'src/new-from-agent.md', status: '??', confidence: 'high' });
    expect(files).toContainEqual({ path: 'src/pre-existing.ts', status: 'M', confidence: 'low' });
    // Only the new file's LOC counts; pre-existing 99/12 is filtered.
    expect(job.linesAdded).toBe(8);
    expect(job.linesRemoved).toBe(0);
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', {
      queueIfBlocked: true,
      sourceJobId: job.id,
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
describe('runCompletionHooks – linked release scoping', () => {
  // Hoist mocks + module load to beforeAll; stable refs reset in beforeEach.
  const startProjectReviewMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startFixFromJobMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
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

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
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
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));
    vi.doMock('@/lib/shared/notifications', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-linked-release-test-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();

    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-auto', pid: 1, logPath: '' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'pushed' });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abcd123', message: 'committed' });
    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-auto', pid: 2 });
    getProjectTestConfigMock.mockReset().mockReturnValue({
      autoPushEnabled: false,
      autoCommitEnabled: false,
      autoPrMergeEnabled: false,
      prWorkflowEnabled: false,
    });
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-test');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/shared/notifications');
    vi.resetModules();
  });

  it('does not append or auto-chain a standalone pipeline job just because another release is active', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'active-release.log');
    writeFileSync(releaseLog, '# release start\n');
    await testDb.db.insert(schema.jobs).values({
      id: 'release-live',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
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
      releaseId: 'release-live',
    } as any);

    const testLog = join(tempDir, 'standalone-test.log');
    writeFileSync(testLog, 'manual test output\n');
    const job = makeJob('test', testLog, { id: 'manual-test-1' });

    await markDoneFn(job, 0);

    expect(readFileSync(releaseLog, 'utf8')).not.toContain('manual test output');
    expect(startProjectReviewMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
    const releaseRow = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'release-live');
    expect(releaseRow?.finishedAt).toBeNull();
  });

  it('appends linked child output into its own active release log', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'linked-release.log');
    writeFileSync(releaseLog, '# release start\n');
    await insertJobsAndSync({
      id: 'release-linked',
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: releaseLog,
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
      releaseId: 'release-linked',
    } as JobInsert);

    const childLog = join(tempDir, 'linked-pr-wait.log');
    writeFileSync(childLog, 'merge poll output\n');
    const job = makeJob('pr-wait', childLog, { id: 'linked-pr-wait-1', releaseId: 'release-linked' });

    await markDoneFn(job, 0);

    await vi.waitFor(() => {
      expect(readFileSync(releaseLog, 'utf8')).toContain('merge poll output');
    }, { timeout: 200, interval: 1 });
  });
});
describe('runCompletionHooks – push→DoD (PR Workflow without auto-merge)', () => {
  let startMarkDodMock: ReturnType<typeof vi.fn>;
  let launchPrWaitMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;
  let jobSeq = 0;

  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-job-${++jobSeq}`,
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

  let storageCache: Map<string, JobData>;

  beforeAll(async () => {
    vi.resetModules();
    startMarkDodMock = vi.fn();
    getProjectTestConfigMock = vi.fn();
    launchPrWaitMock = vi.fn();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
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
    vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ launchPrWait: launchPrWaitMock }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-push-dod-test-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    startMarkDodMock.mockReset().mockResolvedValue({ ok: true, verified: 2, total: 2, changed: true, issueNumber: 55 });
    getProjectTestConfigMock.mockReset().mockReturnValue({
      prWorkflowEnabled: true,
      autoPrMergeEnabled: false,
      autoPushEnabled: false,
    });
    launchPrWaitMock.mockReset().mockReturnValue({ jobId: 'prwait-1' });
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-test');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-mark-dod');
    vi.doUnmock('@/lib/pipeline/start-pr-wait');
    vi.resetModules();
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
describe('runCompletionHooks – abort short-circuit', () => {
  // Hoist mocks + module load to beforeAll; stable refs reset in beforeEach.
  const startProjectReviewMock = vi.fn();
  const startProjectPushMock = vi.fn();
  const startProjectCommitMock = vi.fn();
  const startFixFromJobMock = vi.fn();
  const getProjectTestConfigMock = vi.fn();
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;

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

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
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
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    await truncateAll();
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: true, jobId: 'rev-1' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: true });
    startProjectCommitMock.mockReset().mockResolvedValue({ ok: true, commitSha: 'abc' });
    startFixFromJobMock.mockReset().mockResolvedValue({ ok: true, jobId: 'fix-1' });
    getProjectTestConfigMock.mockReset().mockReturnValue({ autoPushEnabled: true });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.resetModules();
  });

  it('does not chain to next step when active release has abortedAt set', async () => {
    const now = Date.now() / 1000;
    // Insert an aborted release job — finishedAt is set (as the abort handler does)
    await insertJobsAndSync({
      id: 'release-aborted', project: 'abort-proj', kind: 'release',
      prompt: null, pid: 0, logPath: null,
      startedAt: now - 30, finishedAt: now - 1, exitCode: -3,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      abortedAt: now - 1,
    } as JobInsert);

    // Step job must carry releaseId so the abort check can find the release
    const reviewJob = makeJob('review', 'review-after-abort', { releaseId: 'release-aborted' });
    await markDoneFn(reviewJob, 0);

    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startFixFromJobMock).not.toHaveBeenCalled();
  });

  it('does not chain fix→review when active release is aborted', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndSync({
      id: 'release-aborted-2', project: 'abort-proj', kind: 'release',
      prompt: null, pid: 0, logPath: null,
      startedAt: now - 30, finishedAt: now - 1, exitCode: -3,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      abortedAt: now - 1,
    } as JobInsert);

    const fixJob = makeJob('fix', 'fix-after-abort', { releaseId: 'release-aborted-2' });
    await markDoneFn(fixJob, 0);

    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });
});
describe('persistVerdict', () => {
  let createJobFn: typeof import('@/lib/jobs/job-storage').createJob;
  let getJobFn: typeof import('@/lib/jobs/job-storage').getJob;
  let persistVerdictFn: typeof import('@/lib/jobs/job-storage').persistVerdict;
  let awaitInFlightSaveFn: typeof import('@/lib/jobs/storage').awaitInFlightSave;
  let storageCache: Map<string, JobData>;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/jobs/job-storage');
    createJobFn = mod.createJob;
    getJobFn = mod.getJob;
    persistVerdictFn = mod.persistVerdict;
    const storage = await import('@/lib/jobs/storage');
    awaitInFlightSaveFn = storage.awaitInFlightSave;
    storageCache = storage.jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.resetModules();
  });

  it('writes verdict to DB and in-memory cache', async () => {
    const job = createJobFn('proj', 'review', 1, '/log');
    persistVerdictFn(job.id, 'LGTM');

    await awaitInFlightSaveFn(job.id);
    await flushDbQueue();

    const rows = await testDb.db.select().from(schema.jobs);
    const stored = rows.find((r) => r.id === job.id);
    expect(stored?.verdict).toBe('LGTM');

    const cached = getJobFn(job.id);
    expect(cached?.verdict).toBe('LGTM');
  });

  it('updates an existing verdict', async () => {
    const job = createJobFn('proj', 'review', 2, '/log');
    persistVerdictFn(job.id, 'NEEDS ATTENTION');
    persistVerdictFn(job.id, 'DO NOT SHIP');

    await awaitInFlightSaveFn(job.id);
    await flushDbQueue();

    const rows = await testDb.db.select().from(schema.jobs);
    const stored = rows.find((r) => r.id === job.id);
    expect(stored?.verdict).toBe('DO NOT SHIP');

    expect(getJobFn(job.id)?.verdict).toBe('DO NOT SHIP');
  });

  it('silently no-ops for an unknown jobId (no throw)', () => {
    expect(() => persistVerdictFn('nonexistent-job', 'LGTM')).not.toThrow();
  });
});
