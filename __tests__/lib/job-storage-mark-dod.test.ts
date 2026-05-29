import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// Single PGlite instance + single module-load shared across both describe
// blocks. Booting PGlite is ~200ms; doing it twice (one per describe) is
// pure overhead. The two describes use stable mock fn references that get
// reconfigured per-describe in their respective beforeAll hooks.
let sharedHandle: TestDbHandle;
const startMarkDodMock = vi.fn();
const startProjectPushMock = vi.fn();
const startProjectCommitMock = vi.fn();
const startFixFromJobMock = vi.fn();
const startProjectReviewMock = vi.fn();
const startProjectTestMock = vi.fn();
const startFixCiMock = vi.fn();
const getProjectTestConfigMock = vi.fn();
const notifyMock = vi.fn();
const releaseLockMock = vi.fn();

let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
let storageCache: Map<string, JobData>;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);

  vi.resetModules();
  vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  vi.doMock('@/lib/shared/shell', () => ({
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  }));
  vi.doMock('@/lib/git/git-utils', () => ({
    markReviewed: vi.fn().mockResolvedValue(undefined),
    setReviewedRef: vi.fn().mockResolvedValue(undefined),
    getCurrentBranch: vi.fn().mockResolvedValue('master'),
  }));
  vi.doMock('@/lib/shared/project-data', () => ({
    resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
  }));
  vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
  vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
  vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
  vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: startFixFromJobMock }));
  vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: startProjectReviewMock }));
  vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: startProjectTestMock }));
  vi.doMock('@/lib/pipeline/start-fix-ci', () => ({ startFixCi: startFixCiMock }));
  vi.doMock('@/lib/scheduling/scheduling', () => ({
    getProjectTestConfig: getProjectTestConfigMock,
  }));
  vi.doMock('@/lib/shared/notifications', () => ({ notify: notifyMock }));
  vi.doMock('@/lib/pipeline/pipeline-lock', () => ({ releaseLock: releaseLockMock }));
  // Skip retention's maintenance_status writes (table not in test DDL).
  vi.doMock('@/lib/jobs/retention', () => ({
    pruneProjectLogs: vi.fn(),
  }));

  const mod = await import('@/lib/jobs/job-storage');
  markDoneFn = mod.markDone;
  storageCache = (await import('@/lib/jobs/storage')).jobsCache;
});

afterAll(async () => {
  // Drain any straggling fire-and-forget queries via a no-op SELECT before
  // closing. PGlite serializes queries, so awaiting a SELECT 1 flushes
  // anything queued ahead of it without a fixed sleep.
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
  vi.doUnmock('@/lib/db');
  vi.resetModules();
});

async function truncateAll(): Promise<void> {
  await sharedHandle.db.execute(sql.raw(
    'WITH a AS (DELETE FROM jobs RETURNING 1), b AS (DELETE FROM recommendations RETURNING 1), c AS (DELETE FROM job_completion_events RETURNING 1) DELETE FROM gh_issues_cache'
  ));
}

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
      provider text
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
    CREATE TABLE IF NOT EXISTS job_completion_events (
      id serial PRIMARY KEY,
      job_id text NOT NULL UNIQUE,
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
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project text PRIMARY KEY,
      repo text NOT NULL,
      prs text NOT NULL DEFAULT '[]',
      issues text NOT NULL DEFAULT '[]',
      fetched_at double precision NOT NULL
    )
  `));
}

describe('runCompletionHooks – mark-dod integration', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let tempDir: string;

  // Job IDs must be unique per test because `verdict.ts` caches the parsed
  // verdict by `job.id` at module scope. Reusing 'review-job' across tests
  // would return a stale cached verdict from a prior test (since we no
  // longer reset modules between tests for speed).
  let reviewJobCounter = 0;
  function makeReviewJob(logPath: string | null): JobData {
    return {
      id: `review-job-${++reviewJobCounter}`,
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
    await truncateAll();
    storageCache.clear();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-mark-dod-test-'));

    // Reset mock state and reapply default behavior for this describe block.
    startMarkDodMock.mockReset();
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'dod-job', issueNumber: 7, verified: 2, total: 2, changed: true,
    });
    startProjectPushMock.mockReset();
    startProjectPushMock.mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });
    startProjectCommitMock.mockReset();
    startProjectCommitMock.mockResolvedValue({ ok: true, commitSha: 'abc', message: 'committed' });
    startFixFromJobMock.mockReset();
    startFixFromJobMock.mockResolvedValue({ ok: true, jobId: 'fix-job' });
    startProjectReviewMock.mockReset();
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'rev-job' });
    startProjectTestMock.mockReset();
    startProjectTestMock.mockResolvedValue({ ok: true, jobId: 'test-job' });
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(undefined);
    releaseLockMock.mockReset();
    getProjectTestConfigMock.mockReset();
    getProjectTestConfigMock.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      prWorkflowEnabled: true,
    });

    // Seed an issue-linked "run" job so hasIssueContext is true.
    const runWithIssueStartedAt = Date.now() / 1000 - 60;
    const runWithIssueFinishedAt = Date.now() / 1000 - 30;
    await sharedHandle.db.insert(schema.jobs).values({
      id: 'run-with-issue',
      project: 'my-proj',
      kind: 'run',
      pid: 0,
      startedAt: runWithIssueStartedAt,
      finishedAt: runWithIssueFinishedAt,
      exitCode: 0,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'sample',
    });

    // Storage functions like findLatestIssueRunContext read from the in-memory
    // jobsCache (not the DB), so mirror the seeded row into the cache.
    storageCache.set('run-with-issue', {
      id: 'run-with-issue',
      project: 'my-proj',
      kind: 'run',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: runWithIssueStartedAt,
      finishedAt: runWithIssueFinishedAt,
      exitCode: 0,
      seen: false,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'sample',
    });
  });

  afterEach(() => {
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
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: false, prWorkflowEnabled: true });
    const logFile = join(tempDir, 'lgtm-off.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('calls startMarkDod when autoCommitEnabled is true (no autoPush) in PR Workflow', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: true, prWorkflowEnabled: true });
    const logFile = join(tempDir, 'lgtm-commit.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).toHaveBeenCalled();
  });

  it('calls startMarkDod on issue-linked releases even without the old PR workflow flag', async () => {
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: true, autoCommitEnabled: false, prWorkflowEnabled: false });
    const logFile = join(tempDir, 'lgtm-direct.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectCommitMock).toHaveBeenCalled();
  });

  it('does NOT call startMarkDod when there is no linked issue, even in PR Workflow', async () => {
    await handle.db.execute(sql.raw('WITH a AS (DELETE FROM job_completion_events RETURNING 1) DELETE FROM jobs'));
    storageCache.clear();
    const logFile = join(tempDir, 'lgtm-noissue.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).toHaveBeenCalled();
  });

  it('still calls startMarkDod when the release-scoped source row is missing ghIssueRepo but a sibling row has it', async () => {
    await handle.db.execute(sql.raw('WITH a AS (DELETE FROM job_completion_events RETURNING 1) DELETE FROM jobs'));
    storageCache.clear();
    const now = Date.now() / 1000;
    const seededRows = [
      {
        id: 'release-active',
        project: 'my-proj',
        kind: 'release',
        pid: 0,
        startedAt: now - 120,
        finishedAt: null,
        exitCode: null,
        ghIssueNumber: 7,
        ghIssueRepo: null,
        ghIssueTitle: 'sample',
      },
      {
        id: 'issue-source-missing-repo',
        project: 'my-proj',
        kind: 'run',
        pid: 0,
        startedAt: now - 110,
        finishedAt: now - 100,
        exitCode: 0,
        releaseId: 'release-active',
        ghIssueNumber: 7,
        ghIssueRepo: null,
        ghIssueTitle: 'sample',
      },
      {
        id: 'issue-sibling-with-repo',
        project: 'my-proj',
        kind: 'fix',
        pid: 0,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
        releaseId: 'release-active',
        ghIssueNumber: 7,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'sample',
      },
    ];
    await handle.db.insert(schema.jobs).values(seededRows);
    for (const row of seededRows) {
      storageCache.set(row.id, {
        prompt: null,
        logPath: null,
        seen: false,
        ...row,
      } as JobData);
    }

    const logFile = join(tempDir, 'lgtm-recover-repo.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);

    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj');
    expect(startProjectCommitMock).toHaveBeenCalled();
  });

  it('defers mark-dod (does NOT call it inline) when auto_pr_merge_enabled is true', async () => {
    getProjectTestConfigMock.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      prWorkflowEnabled: true,
      autoPrMergeEnabled: true,
    });
    const logFile = join(tempDir, 'lgtm-defer.log');
    writeFileSync(logFile, 'Verdict: LGTM\n');
    await markDoneFn(makeReviewJob(logFile), 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).toHaveBeenCalled();
  });
});

describe('runCompletionHooks – mark-dod excluded from pipeline endpoint', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };

  async function insertReleaseJob(id: string) {
    const now = Date.now() / 1000;
    await handle.db.insert(schema.jobs).values({
      id,
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: now - 10,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    });
    // Mirror into the in-memory jobsCache so getJob()/listJobs() in lifecycle
    // hooks can find the release row.
    storageCache.set(id, {
      id,
      project: 'my-proj',
      kind: 'release',
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: now - 10,
      finishedAt: null,
      exitCode: null,
      seen: false,
    });
  }

  // Job IDs must be unique per test because this describe shares the loaded
  // module (and therefore module-level caches like `verdictCache`) with the
  // first describe block. Reusing `${kind}-job` would let stale state leak.
  let jobCounter = 0;
  function makeJob(kind: string, exitCodeOverride?: number): JobData {
    return {
      id: `${kind}-job-${++jobCounter}`,
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
    await truncateAll();
    storageCache.clear();
    // Reapply this describe block's failing-mocks defaults on top of the
    // shared mock fns. The first describe configures them with success
    // responses; this describe configures them with the no-op / failure
    // responses these regression tests need.
    startMarkDodMock.mockReset();
    startMarkDodMock.mockResolvedValue({ ok: false, detail: 'no issue' });
    startProjectPushMock.mockReset();
    startProjectPushMock.mockResolvedValue({ ok: false, detail: 'no remote' });
    startProjectCommitMock.mockReset();
    startProjectCommitMock.mockResolvedValue({ ok: false, detail: 'nothing to commit' });
    startFixFromJobMock.mockReset();
    startFixFromJobMock.mockResolvedValue({ ok: false, detail: 'no' });
    startProjectReviewMock.mockReset();
    startProjectReviewMock.mockResolvedValue({ ok: false, detail: 'no' });
    startProjectTestMock.mockReset();
    startProjectTestMock.mockResolvedValue({ ok: false, detail: 'no' });
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(undefined);
    releaseLockMock.mockReset();
    getProjectTestConfigMock.mockReset();
    getProjectTestConfigMock.mockReturnValue({ autoPushEnabled: false, autoCommitEnabled: false });
  });

  it('does not finalize the active release job when mark-dod completes with exit 0', async () => {
    await insertReleaseJob('release-dod-0');
    await markDoneFn(makeJob('mark-dod'), 0);
    const rows = await handle.db.select().from(schema.jobs);
    const row = rows.find((r) => r.id === 'release-dod-0');
    expect(row?.finishedAt).toBeNull();
    expect(row?.exitCode).toBeNull();
  });

  it('does not finalize the active release job when mark-dod completes with exit 1', async () => {
    await insertReleaseJob('release-dod-1');
    await markDoneFn(makeJob('mark-dod'), 1);
    const rows = await handle.db.select().from(schema.jobs);
    const row = rows.find((r) => r.id === 'release-dod-1');
    expect(row?.finishedAt).toBeNull();
    expect(row?.exitCode).toBeNull();
  });

  it('does not send a notification when mark-dod completes', async () => {
    await insertReleaseJob('release-dod-notify');
    await markDoneFn(makeJob('mark-dod'), 0);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('pr-wait still finalizes the active release job with exit 0 (regression)', async () => {
    await insertReleaseJob('release-prwait-0');
    await markDoneFn({ ...makeJob('pr-wait'), releaseId: 'release-prwait-0' }, 0);
    const rows = await handle.db.select().from(schema.jobs);
    const row = rows.find((r) => r.id === 'release-prwait-0');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
  });

  it('pr-wait still finalizes the active release job with exit 1 (regression)', async () => {
    await insertReleaseJob('release-prwait-1');
    await markDoneFn({ ...makeJob('pr-wait'), releaseId: 'release-prwait-1' }, 1);
    const rows = await handle.db.select().from(schema.jobs);
    const row = rows.find((r) => r.id === 'release-prwait-1');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(1);
  });
});
