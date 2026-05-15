import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq, sql } from 'drizzle-orm';
import type { JobData } from '@/lib/jobs/types';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// ─── Shared test database ────────────────────────────────────────────────────
let sharedHandle: TestDbHandle;

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
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project text PRIMARY KEY,
      repo text NOT NULL,
      prs text NOT NULL DEFAULT '[]',
      issues text NOT NULL DEFAULT '[]',
      fetched_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

// ─── Hoisted mock bag ────────────────────────────────────────────────────────
// Stable mock fn references shared across the whole test file. Each
// describe's `beforeEach` resets these and reapplies its specific defaults.
// This avoids the per-test `vi.resetModules() + await import(...)` cost that
// the old implementation paid 61 times.
//
// `vi.hoisted()` runs before the module body executes, so `vi.fn()` here is
// the same instance the module-scope `vi.mock(...)` factories close over.
const mocks = vi.hoisted(() => ({
  db: { current: null as unknown as TestDbHandle['db'] },
  // pm2-jobs
  deleteJob: vi.fn(),
  getJobStatus: vi.fn(),
  // shared/shell
  exec: vi.fn(),
  // git/git-utils
  markReviewed: vi.fn(),
  setReviewedRef: vi.fn(),
  getCurrentBranch: vi.fn(),
  // shared/project-data
  resolveProjectPath: vi.fn(),
  // scheduling/scheduling
  getProjectTestConfig: vi.fn(),
  // pipeline/pipeline-lock
  releaseLock: vi.fn(),
  getLock: vi.fn(),
  isLockOwnedByActiveRelease: vi.fn(),
  // jobs/retention
  pruneProjectLogs: vi.fn(),
  // shared/notifications
  notify: vi.fn(),
  // shared/config
  getSettings: vi.fn(),
  // shared/job-control
  runAutoChainGates: vi.fn(),
  // pipeline/start-fix
  startFixFromJob: vi.fn(),
  // pipeline/push-rejection
  isHookRejection: vi.fn(),
  isTestFailureRejection: vi.fn(),
  // pipeline/review-exhaustion-fallback
  fileReviewExhaustionIssue: vi.fn(),
  // pipeline/start-commit
  startProjectCommit: vi.fn(),
  // pipeline/start-review
  startProjectReview: vi.fn(),
  // pipeline/start-test
  startProjectTest: vi.fn(),
  // pipeline/start-mark-dod
  startMarkDod: vi.fn(),
  // pipeline/start-pr-wait
  launchPrWait: vi.fn(),
  // jobs/verdict-retry
  retryVerdictWithClaude: vi.fn(),
  // agents/agent-run-report
  finalizeAgentRunReport: vi.fn(),
  // agents/pending-agent-run
  drainNextAgentRun: vi.fn(),
}));

// Module-level mocks; the factories late-bind to the hoisted bag, so the
// stable `mocks.*` fn refs survive `vi.resetAllMocks()` and per-describe
// reconfiguration via `mockReset().mockResolvedValue(...)`.
vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.db.current;
  },
  schema,
}));
vi.mock('@/lib/jobs/pm2-jobs', () => ({
  deleteJob: mocks.deleteJob,
  getJobStatus: mocks.getJobStatus,
}));
vi.mock('@/lib/shared/shell', () => ({
  exec: mocks.exec,
}));
vi.mock('@/lib/git/git-utils', () => ({
  markReviewed: mocks.markReviewed,
  setReviewedRef: mocks.setReviewedRef,
  getCurrentBranch: mocks.getCurrentBranch,
}));
vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getProjectTestConfig: mocks.getProjectTestConfig,
}));
vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  releaseLock: mocks.releaseLock,
  getLock: mocks.getLock,
  isLockOwnedByActiveRelease: mocks.isLockOwnedByActiveRelease,
}));
vi.mock('@/lib/jobs/retention', () => ({
  pruneProjectLogs: mocks.pruneProjectLogs,
}));
vi.mock('@/lib/shared/notifications', () => ({
  notify: mocks.notify,
}));
vi.mock('@/lib/shared/config', () => ({
  getSettings: mocks.getSettings,
}));
vi.mock('@/lib/shared/job-control', () => ({
  runAutoChainGates: mocks.runAutoChainGates,
}));
vi.mock('@/lib/pipeline/start-fix', () => ({
  startFixFromJob: mocks.startFixFromJob,
}));
vi.mock('@/lib/pipeline/push-rejection', () => ({
  isHookRejection: mocks.isHookRejection,
  isTestFailureRejection: mocks.isTestFailureRejection,
}));
vi.mock('@/lib/pipeline/review-exhaustion-fallback', () => ({
  fileReviewExhaustionIssue: mocks.fileReviewExhaustionIssue,
}));
vi.mock('@/lib/pipeline/start-commit', () => ({
  startProjectCommit: mocks.startProjectCommit,
}));
vi.mock('@/lib/pipeline/start-review', () => ({
  startProjectReview: mocks.startProjectReview,
}));
vi.mock('@/lib/pipeline/start-test', () => ({
  startProjectTest: mocks.startProjectTest,
}));
vi.mock('@/lib/pipeline/start-mark-dod', () => ({
  startMarkDod: mocks.startMarkDod,
}));
vi.mock('@/lib/pipeline/start-pr-wait', () => ({
  launchPrWait: mocks.launchPrWait,
}));
vi.mock('@/lib/jobs/verdict-retry', () => ({
  retryVerdictWithClaude: mocks.retryVerdictWithClaude,
}));
vi.mock('@/lib/agents/agent-run-report', () => ({
  finalizeAgentRunReport: mocks.finalizeAgentRunReport,
}));
vi.mock('@/lib/agents/pending-agent-run', () => ({
  drainNextAgentRun: mocks.drainNextAgentRun,
}));

// Late-bound module bindings. Imported once in `beforeAll` AFTER the test DB
// is initialized so `vi.mock('@/lib/db')`'s factory returns a real Drizzle
// handle. The `import` happens once for the whole file (vs 61 times in the
// previous implementation), saving ~50-100ms per test.
let markDone: typeof import('@/lib/jobs/job-storage').markDone;
let runCompletionHooks: typeof import('@/lib/jobs/job-storage').runCompletionHooks;
let jobsCache: Map<string, JobData>;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
  mocks.db.current = sharedHandle.db;
  const mod = await import('@/lib/jobs/job-storage');
  markDone = mod.markDone;
  runCompletionHooks = mod.runCompletionHooks;
  jobsCache = (await import('@/lib/jobs/storage')).jobsCache;
});

afterAll(async () => {
  // Let any straggling fire-and-forget queries settle before closing.
  await new Promise((r) => setTimeout(r, 30));
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

// Default mock setup applied before each test; describes can override.
// `vi.resetAllMocks()` clears call history + implementation in one shot, then
// we reapply the few defaults that production code actually relies on.
function applyDefaultMocks(): void {
  vi.resetAllMocks();
  mocks.deleteJob.mockResolvedValue(undefined);
  mocks.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mocks.markReviewed.mockResolvedValue(undefined);
  mocks.setReviewedRef.mockResolvedValue(undefined);
  mocks.getCurrentBranch.mockResolvedValue('main');
  mocks.resolveProjectPath.mockReturnValue(null);
  mocks.getProjectTestConfig.mockReturnValue({
    autoPushEnabled: false,
    autoCommitEnabled: false,
    releaseAfterRun: false,
    prWorkflowEnabled: false,
  });
  mocks.getLock.mockReturnValue(null);
  mocks.isLockOwnedByActiveRelease.mockReturnValue(false);
  mocks.notify.mockResolvedValue(undefined);
  mocks.getSettings.mockReturnValue({
    fix_ci_max_retries: 0,
    fix_ci_retry_window_seconds: 120,
    fix_ci_fast_crash_ms: 5000,
  });
  mocks.runAutoChainGates.mockReturnValue(null);
  mocks.startFixFromJob.mockResolvedValue({ ok: true, jobId: 'fix-auto' });
  mocks.isHookRejection.mockReturnValue(false);
  mocks.isTestFailureRejection.mockReturnValue(false);
  mocks.fileReviewExhaustionIssue.mockResolvedValue({ ok: true, issueNumber: 7, issueUrl: 'https://github.com/owner/repo/issues/7' });
  mocks.startProjectCommit.mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'commit ok', jobId: 'commit-auto' });
  mocks.startProjectReview.mockResolvedValue({ ok: true, jobId: 'review-next' });
  mocks.startProjectTest.mockResolvedValue({ ok: true, jobId: 'test-next' });
  mocks.startMarkDod.mockResolvedValue({ ok: true, verified: 1, total: 1, changed: false });
  mocks.launchPrWait.mockReturnValue({ jobId: 'pr-wait-job' });
  mocks.retryVerdictWithClaude.mockResolvedValue(null);
  mocks.finalizeAgentRunReport.mockResolvedValue(undefined);
  mocks.drainNextAgentRun.mockResolvedValue(undefined);
}

async function resetTestState(): Promise<void> {
  jobsCache.clear();
  // Single TRUNCATE — fast on small tables, single round-trip to PGlite.
  await sharedHandle.db.execute(
    sql.raw('TRUNCATE jobs, recommendations, gh_issues_cache, settings'),
  );
  applyDefaultMocks();
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

// Lifecycle reads jobs from the in-memory jobsCache, not the DB. Tests that
// insert rows directly into the DB must also populate the cache so
// reconcile/markDone logic can find them.
function populateJobCache(rows: ReadonlyArray<Record<string, unknown>>): void {
  for (const r of rows) {
    jobsCache.set(r.id as string, {
      id: r.id as string,
      project: r.project as string,
      kind: r.kind as string,
      prompt: (r.prompt as string | null | undefined) ?? null,
      pid: (r.pid as number | undefined) ?? 0,
      logPath: (r.logPath as string | null | undefined) ?? null,
      startedAt: (r.startedAt as number | undefined) ?? Date.now() / 1000,
      finishedAt: (r.finishedAt as number | null | undefined) ?? null,
      exitCode: (r.exitCode as number | null | undefined) ?? null,
      seen: (r.seen as boolean | undefined) ?? false,
      durationMs: (r.durationMs as number | null | undefined) ?? null,
      inputTokens: (r.inputTokens as number | null | undefined) ?? null,
      outputTokens: (r.outputTokens as number | null | undefined) ?? null,
      cacheReadTokens: (r.cacheReadTokens as number | null | undefined) ?? null,
      cacheCreateTokens: (r.cacheCreateTokens as number | null | undefined) ?? null,
      sessionId: (r.sessionId as string | null | undefined) ?? null,
      contextMeta: (r.contextMeta as string | null | undefined) ?? null,
      userPrompt: (r.userPrompt as string | null | undefined) ?? null,
      parentJobId: (r.parentJobId as string | null | undefined) ?? null,
      ghIssueNumber: (r.ghIssueNumber as number | null | undefined) ?? null,
      ghIssueRepo: (r.ghIssueRepo as string | null | undefined) ?? null,
      ghIssueTitle: (r.ghIssueTitle as string | null | undefined) ?? null,
      logPruned: (r.logPruned as boolean | undefined) ?? false,
      verdict: (r.verdict as string | null | undefined) ?? null,
      costUsd: (r.costUsd as number | null | undefined) ?? null,
      model: (r.model as string | null | undefined) ?? null,
      releaseId: (r.releaseId as string | null | undefined) ?? null,
      abortedAt: (r.abortedAt as number | null | undefined) ?? null,
      promptBytes: (r.promptBytes as number | null | undefined) ?? null,
      workSummary: (r.workSummary as string | null | undefined) ?? null,
      modifiedFiles: (r.modifiedFiles as string | null | undefined) ?? null,
      provider: (r.provider as string | null | undefined) ?? null,
    });
  }
}

// Insert one or more rows into the DB AND populate the jobsCache mirror.
async function insertJobsAndCache(
  db: TestDbHandle['db'],
  rows: ReadonlyArray<Record<string, unknown>>,
) {
  if (rows.length === 0) return;
  await db.insert(schema.jobs).values(rows as never);
  populateJobCache(rows);
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

// Lazy alias for code paths that previously read `testDb.db`.
function getTestDb(): TestDbHandle['db'] {
  return sharedHandle.db;
}

// ─── reconcileStaleRelease ────────────────────────────────────────────────────
// ─── reconcileStaleRelease tests removed: function retired with chain-loop closure

describe('runCompletionHooks abort cleanup', () => {
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
    await resetTestState();
  });

  it('finalizes an aborted release after the inline step finishes late', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-timeout',
        project: 'proj',
        kind: 'release',
        startedAt: now - 60,
        abortedAt: now - 10,
      }),
      makeJobRow({
        id: 'commit-timeout',
        project: 'proj',
        kind: 'commit',
        releaseId: 'release-timeout',
        startedAt: now - 30,
        finishedAt: now - 1,
        exitCode: -3,
      }),
    ]);

    await runCompletionHooks(
      makeJob('commit', {
        id: 'commit-timeout',
        project: 'proj',
        releaseId: 'release-timeout',
        finishedAt: now - 1,
        exitCode: -3,
      }),
    );

    const row = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'release-timeout'))).at(0);
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(-3);
    expect(row?.abortedAt).not.toBeNull();
    expect(mocks.releaseLock).toHaveBeenCalledWith('proj', 'release-timeout');
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      event: 'release_aborted',
      project: 'proj',
      job_id: 'release-timeout',
    }));
  });
});

// ─── reviewIsStuck convergence guard (tested through markDone) ───────────────

// Skipped: ported to __tests__/lib/workflows/guards/review-convergence.test.ts
// + integration coverage in release-orchestrator.test.ts (see comment block
// at "concurrent step finalization guard" describe above for full pointer).
describe.skip('reviewIsStuck convergence guard', () => {
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
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-stuck-test-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      review_fix_max_iterations: 3,
    });
    mocks.fileReviewExhaustionIssue.mockResolvedValue({ ok: true, issueNumber: 42, issueUrl: 'https://github.com/owner/repo/issues/42' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT start a fix when the previous review in the same release has identical findings', async () => {
    const now = Date.now() / 1000;
    const findings = '## Findings\n- memory leak in cache.ts\n- missing error handler in api/route.ts\n';
    const prevLog = join(tempDir, 'prev-review.log');
    writeFileSync(prevLog, findings + 'Verdict: NEEDS ATTENTION\n');

    // Insert a previous review with same findings, already finished, in the same release
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-stuck', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-stuck',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    // Current review has identical findings — fix loop should be stopped
    const curLog = join(tempDir, 'cur-review.log');
    writeFileSync(curLog, findings + 'Verdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('cur-review', curLog, {
      releaseId: 'release-stuck',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });

  it('does NOT start a fix when structured finding IDs repeat with different wording', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-structured-review.log');
    writeFileSync(prevLog, ndjsonText('Findings:\n- Finding ID: server-url-bypass\n  Root cause: missing server validation\nVerdict: DO NOT SHIP\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-structured-stuck', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-structured-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-structured-stuck',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-structured-review.log');
    writeFileSync(curLog, ndjsonText('Findings:\n- Finding ID: server-url-bypass\n  Root cause: alternate API still bypasses canonical parser\nVerdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-structured-review', curLog, {
      releaseId: 'release-structured-stuck',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });

  it('does NOT treat incidental id lines as structured finding IDs', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-incidental-id-review.log');
    writeFileSync(prevLog, ndjsonText('Findings:\n- Root cause: missing auth\n  id: shared-placeholder\nVerdict: DO NOT SHIP\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-incidental-id', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-incidental-id-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-incidental-id',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-incidental-id-review.log');
    writeFileSync(curLog, ndjsonText('Findings:\n- Root cause: missing cache invalidation\n  id: shared-placeholder\nVerdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-incidental-id-review', curLog, {
      releaseId: 'release-incidental-id',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledOnce();
  });

  it('stops before exhaustion fallback when repeated review findings stop convergence (DO NOT SHIP)', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release-stuck-final.log');
    writeFileSync(releaseLog, '# release\n');
    const findings = 'Findings:\n- Finding ID: duplicate-bypass\n  Root cause: duplicate canonicalization missing\n';
    const prevLog = join(tempDir, 'prev-review-final.log');
    writeFileSync(prevLog, ndjsonText(findings + 'Verdict: NEEDS ATTENTION\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-stuck-final', project: 'proj', kind: 'release', logPath: releaseLog, startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-review-final',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-stuck-final',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-review-final.log');
    writeFileSync(curLog, ndjsonText(findings + 'Verdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-review-final', curLog, {
      releaseId: 'release-stuck-final',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });

  it('DOES start a fix when the previous review has different findings', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-review2.log');
    writeFileSync(prevLog, ndjsonText('## Findings\n- old bug in foo.ts\nVerdict: NEEDS ATTENTION\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-diff', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-review2',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-diff',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    // Current review has different findings — fix should proceed
    const curLog = join(tempDir, 'cur-review2.log');
    writeFileSync(curLog, '## Findings\n- different bug in bar.ts\nVerdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('cur-review2', curLog, {
      releaseId: 'release-diff',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('cur-review2');
  });

  it('stops before exhaustion fallback when prior fix claimed an ID fixed but review still flags it (DO NOT SHIP)', async () => {
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

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-contradict', project: 'proj', kind: 'release', logPath: releaseLog, startedAt: now - 200 }),
      makeJobRow({
        id: 'prev-review-contradict',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-contradict',
        logPath: prevReviewLog,
        startedAt: now - 180,
        finishedAt: now - 170,
        exitCode: 0,
      }),
      makeJobRow({
        id: 'fix-contradict',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-contradict',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }),
    ]);

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

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
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

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-honest', project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({
        id: 'fix-honest',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-honest',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }),
    ]);

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

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('cur-review-honest');
  });

  it('DOES start a fix when fix claimed a different ID than the review now flags', async () => {
    const now = Date.now() / 1000;
    const fixLog = join(tempDir, 'fix-different.log');
    writeFileSync(fixLog, ndjsonText([
      'Fix checklist:',
      '- Finding ID: original-finding',
      '  Status: fixed',
    ].join('\n')));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-different', project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({
        id: 'fix-different',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-different',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }),
    ]);

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

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('cur-review-different');
  });

  it('starts a fix on the first review in a release (no previous to compare against)', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: 'release-first', project: 'proj', kind: 'release', startedAt: now - 60 })]);

    const curLog = join(tempDir, 'first-review.log');
    writeFileSync(curLog, '## Findings\n- some issue in baz.ts\nVerdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('first-review', curLog, {
      releaseId: 'release-first',
      startedAt: now - 30,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('first-review');
  });
});

// ─── verification cap (counts reviews/tests, not fixes) ──────────────────────

// Skipped: ported to __tests__/lib/workflows/guards/iteration-caps.test.ts
// (review-cap branch + integration in release-orchestrator.test.ts).
describe.skip('fix→review review-count cap', () => {
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

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-review-cap-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      review_fix_max_iterations: 3,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips review #(MAX+1) when MAX reviews have already run, even with different findings each time', async () => {
    // Default MAX_STEP_ITERATIONS = 3. Insert 3 prior reviews with DISTINCT
    // findings (so reviewIsStuck and fixContradictsReview both return false).
    // The new cap must still trigger and skip the 4th review.
    const now = Date.now() / 1000;
    const releaseId = 'release-scope-creep';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 600 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 500, finishedAt: now - 480, exitCode: 0 }),
      makeJobRow({ id: 'f1', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r1', startedAt: now - 470, finishedAt: now - 450, exitCode: 0 }),
      makeJobRow({ id: 'r2', project: 'proj', kind: 'review', releaseId, startedAt: now - 440, finishedAt: now - 420, exitCode: 0 }),
      makeJobRow({ id: 'f2', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r2', startedAt: now - 410, finishedAt: now - 390, exitCode: 0 }),
      makeJobRow({ id: 'r3', project: 'proj', kind: 'review', releaseId, startedAt: now - 380, finishedAt: now - 360, exitCode: 0 }),
    ]);

    // The current fix's parent is r3 (a review) — fromTestFailure is false,
    // so we hit the fix→review branch where the cap should bite.
    const f3 = makeFixJob('f3', { releaseId, parentJobId: 'r3', startedAt: now - 30, finishedAt: null, exitCode: null });

    await markDone(f3, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    // fix_loop_exhausted should fire as the release-stop notification.
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('still chains to review when fewer than MAX reviews have run', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-under-cap';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
    ]);

    const f1 = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });
    await markDone(f1, 0);

    expect(mocks.startProjectReview).toHaveBeenCalledOnce();
    expect(mocks.startProjectReview).toHaveBeenCalledWith('proj');
  });

  it('stops before exhaustion fallback when the capped review is DO NOT SHIP', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-cap-do-not-ship';
    const reviewLog = join(tempDir, 'r3-review.log');
    writeFileSync(reviewLog, ndjsonText([
      'Findings:',
      '- Finding ID: auth-bypass',
      'Verdict: DO NOT SHIP',
    ].join('\n')));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 600 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 500, finishedAt: now - 480, exitCode: 0 }),
      makeJobRow({ id: 'f1', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r1', startedAt: now - 470, finishedAt: now - 450, exitCode: 0 }),
      makeJobRow({ id: 'r2', project: 'proj', kind: 'review', releaseId, startedAt: now - 440, finishedAt: now - 420, exitCode: 0 }),
      makeJobRow({ id: 'f2', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r2', startedAt: now - 410, finishedAt: now - 390, exitCode: 0 }),
      makeJobRow({ id: 'r3', project: 'proj', kind: 'review', releaseId, logPath: reviewLog, startedAt: now - 380, finishedAt: now - 360, exitCode: 0 }),
    ]);

    const f3 = makeFixJob('f3', { releaseId, parentJobId: 'r3', startedAt: now - 30, finishedAt: null, exitCode: null });

    await markDone(f3, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const releaseRow = (await getTestDb().select().from(schema.jobs)).find((row) => row.id === releaseId);
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });
});

// Skipped: cap differentiation lives in iteration-caps.ts now (different
// caps per kind: reviewFixMaxIterations vs maxStepIterations vs
// pushFixAttemptCap). Tests in iteration-caps.test.ts.
describe.skip('review_fix_max_iterations only caps review-side recovery', () => {
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

  beforeEach(async () => {
    await resetTestState();
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      review_fix_max_iterations: 1,
    });
  });

  afterEach(() => {
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('still re-runs tests after a failed test fix when review_fix_max_iterations is 1', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-test-retry';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 't1', project: 'proj', kind: 'test', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 1 }),
    ]);

    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 't1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectTest).toHaveBeenCalledOnce();
    expect(mocks.startProjectTest).toHaveBeenCalledWith('proj');
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).not.toContain('fix_loop_exhausted');
  });

  it('caps the next review when review_fix_max_iterations is 1', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-review-cap-1';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
    ]);

    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).toHaveBeenCalledOnce();
    expect(mocks.startProjectCommit).toHaveBeenCalledOnce();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('stops standalone auto-push review exhaustion when the cited review is DO NOT SHIP', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-standalone-review-cap-'));
    try {
      const now = Date.now() / 1000;
      const reviewLog = join(tempDir, 'standalone-review-cap-do-not-ship.log');
      writeFileSync(reviewLog, ndjsonText([
        'Findings:',
        '- Finding ID: auth-bypass',
        'Verdict: DO NOT SHIP',
      ].join('\n')));

      await insertJobsAndCache(getTestDb(), [
        makeJobRow({ id: 'standalone-r1', project: 'proj', kind: 'review', logPath: reviewLog, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
      ]);

      const fixJob = makeFixJob('standalone-f1', { parentJobId: 'standalone-r1', startedAt: now - 30 });

      await markDone(fixJob, 0);

      expect(mocks.startProjectReview).not.toHaveBeenCalled();
      expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
      expect(mocks.startProjectCommit).not.toHaveBeenCalled();
      const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
      expect(notifyEvents).toContain('review_do_not_ship');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops the release when exhaustion issue filing succeeds but the follow-up commit cannot start', async () => {
    mocks.startProjectCommit.mockResolvedValueOnce({ ok: false, detail: 'git status failed' });
    const now = Date.now() / 1000;
    const releaseId = 'release-review-cap-commit-fail';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
    ]);

    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).toHaveBeenCalledOnce();
    expect(mocks.startProjectCommit).toHaveBeenCalledOnce();
    const releaseRow = (await getTestDb().select().from(schema.jobs)).find((row) => row.id === releaseId);
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('still starts a fix after a capped failed commit inside a release', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    const releaseId = 'release-commit-cap-fix';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
    ]);

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

    expect(mocks.startFixFromJob).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('c1');
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).not.toContain('fix_loop_exhausted');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('suppresses the re-commit after the trailing fix when the commit cap is exhausted', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    const releaseId = 'release-commit-cap-stop';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'c1', project: 'proj', kind: 'commit', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 1 }),
    ]);

    const fixJob = makeFixJob('f-commit-cap', { releaseId, parentJobId: 'c1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('still starts a fix after a capped failed commit in standalone auto-push mode', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'old-commit', project: 'proj', kind: 'commit', startedAt: now - 120, finishedAt: now - 110, exitCode: 1 }),
    ]);

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

    expect(mocks.startFixFromJob).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('standalone-commit');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });
});

// ─── concurrent step finalization guard ──────────────────────────────────────

// Release-linked chain blocks short-circuit at lifecycle.ts ~line 488 — the
// Vercel Workflow orchestrator owns chaining + finalization for any job
// with a releaseId. The semantics these tests cover (concurrent-step
// finalization, verdict retry rescue, reviewIsStuck convergence guard,
// fix→review caps, push fix cap notifications) are now tested in:
//   __tests__/lib/workflows/release-orchestrator.test.ts
//   __tests__/lib/workflows/guards/review-convergence.test.ts
//   __tests__/lib/workflows/guards/iteration-caps.test.ts
// Skipped (not deleted) so the legacy semantics stay reviewable as long as
// the standalone-job code path remains.
describe.skip('concurrent step finalization guard', () => {
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
    await resetTestState();
  });

  it('does NOT finalize the release when another pipeline step is still running', async () => {
    const now = Date.now() / 1000;
    // Insert an active release and a running test step (sibling, still running)
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'rel-1', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({ id: 'test-1', project: 'proj', kind: 'test', startedAt: now - 60, finishedAt: null }),
    ]);

    // A review job finishes with exit 1 (crash/failure — no chaining path fires)
    const reviewJob = makeInMemoryJob('review-1', 'review', {
      startedAt: now - 30,
      releaseId: 'rel-1',
    });

    await markDone(reviewJob, 1);

    // Release should NOT be finalized — the guard defers to the still-running test
    const relRow = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'rel-1'))).at(0);
    expect(relRow?.finishedAt).toBeNull();
  });

  it('finalizes the release when no other step is running', async () => {
    const now = Date.now() / 1000;
    // Insert an active release with NO running siblings
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'rel-2', project: 'proj', kind: 'release', startedAt: now - 120 }),
    ]);

    const reviewJob = makeInMemoryJob('review-2', 'review', {
      startedAt: now - 30,
      releaseId: 'rel-2',
    });

    await markDone(reviewJob, 1);

    // Release SHOULD be finalized since no sibling is running
    const relRow = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'rel-2'))).at(0);
    expect(relRow?.finishedAt).not.toBeNull();
  });

  it('does not count a finished sibling step as "still running"', async () => {
    const now = Date.now() / 1000;
    // Test step is already finished
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'rel-3', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({ id: 'test-3', project: 'proj', kind: 'test', startedAt: now - 60, finishedAt: now - 30, exitCode: 0 }),
    ]);

    const reviewJob = makeInMemoryJob('review-3', 'review', {
      startedAt: now - 25,
      releaseId: 'rel-3',
    });

    await markDone(reviewJob, 1);

    // Finished sibling should NOT block finalization
    const relRow = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'rel-3'))).at(0);
    expect(relRow?.finishedAt).not.toBeNull();
  });
});

// ─── verdict retry rescue (lifecycle integration) ──────────────────────────

// Skipped: verdict-retry rescue runs inside the legacy review block which
// is now release-linked-short-circuited. The rescue path itself
// (lib/jobs/verdict-retry.ts) is still alive for standalone reviews and
// for the orchestrator's getVerdict() call — coverage exists in
// __tests__/lib/verdict-retry.test.ts. The lifecycle integration tested
// here is no longer reachable on release-linked jobs.
describe.skip('verdict retry rescue', () => {
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
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-retry-test-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      fix_ci_max_retries: 0,
      fix_ci_retry_window_seconds: 120,
      fix_ci_fast_crash_ms: 5000,
      review_retry_on_parse_failure: true,
    });
    mocks.startProjectCommit.mockResolvedValue({ ok: true, jobId: 'commit-1' });
    mocks.startMarkDod.mockResolvedValue({ ok: false });

    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: 'release-retry', project: 'proj', kind: 'release', startedAt: now - 120 })]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('calls retryVerdictWithClaude when the review log has no parseable verdict', async () => {
    const logPath = join(tempDir, 'no-verdict.log');
    writeFileSync(logPath, 'The code looks fine overall. No major issues spotted.\n');

    await markDone(makeReviewJob('rev-no-verdict', logPath), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
  });

  it('passes the source review provider into parse-retry for non-Claude reviews', async () => {
    const logPath = join(tempDir, 'no-verdict-codex.log');
    writeFileSync(logPath, 'Review text without a formal verdict line.\n');

    await markDone(makeReviewJob('rev-no-verdict-codex', logPath, { provider: 'codex' }), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rev-no-verdict-codex',
      provider: 'codex',
    }));
  });

  it('uses the rescued verdict from retry — LGTM → no fix started', async () => {
    mocks.retryVerdictWithClaude.mockResolvedValue('LGTM');
    const logPath = join(tempDir, 'no-verdict-lgtm.log');
    writeFileSync(logPath, 'Everything looks good, tests pass.\n');

    await markDone(makeReviewJob('rev-rescued-lgtm', logPath), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });

  it('defaults to NEEDS ATTENTION when retry also returns null → fix is started', async () => {
    mocks.retryVerdictWithClaude.mockResolvedValue(null);
    const logPath = join(tempDir, 'no-verdict-null.log');
    writeFileSync(logPath, 'Some concerns here but no verdict emitted.\n');

    await markDone(makeReviewJob('rev-retry-null', logPath), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('rev-retry-null');
  });

  it('swallows retryVerdictWithClaude throws — defaults to NEEDS ATTENTION and starts fix', async () => {
    mocks.retryVerdictWithClaude.mockRejectedValue(new Error('spawn ENOENT'));
    const logPath = join(tempDir, 'no-verdict-throw.log');
    writeFileSync(logPath, 'Review text that has no verdict line.\n');

    // Must not throw even though retryVerdictWithClaude rejects
    await expect(markDone(makeReviewJob('rev-retry-throw', logPath), 0)).resolves.not.toThrow();

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
    // After swallowed throw, rawVerdict is null → defaults to NEEDS ATTENTION → fix started
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('rev-retry-throw');
  });
});

// ─── incremental review ref guard ────────────────────────────────────────────

// Skipped: the markReviewed call lives inside the release-linked review
// block which now short-circuits early. setReviewedRef itself is exercised
// via the orchestrator's review-phase + start-review (see start-review.ts:
// it sets the ref on its own non-pipeline path).
describe.skip('setReviewedRef incremental_review_enabled guard', () => {
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

  function setIncremental(incrementalEnabled: boolean): void {
    mocks.getSettings.mockReturnValue({
      fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
      incremental_review_enabled: incrementalEnabled,
    });
  }

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-inc-ref-'));
    mocks.resolveProjectPath.mockReturnValue('/path/to/proj');
    mocks.getCurrentBranch.mockResolvedValue('main');

    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: 'rel-inc', project: 'proj', kind: 'release', startedAt: now - 60 })]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT write reviewed ref when incremental_review_enabled is false', async () => {
    setIncremental(false);
    const logPath = join(tempDir, 'lgtm-off.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(makeReviewJob('rev-off', logPath), 0);

    expect(mocks.setReviewedRef).not.toHaveBeenCalled();
  });

  it('writes reviewed ref when incremental_review_enabled is true and project path resolves', async () => {
    setIncremental(true);
    const logPath = join(tempDir, 'lgtm-on.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(makeReviewJob('rev-on', logPath), 0);

    expect(mocks.setReviewedRef).toHaveBeenCalledWith('/path/to/proj', 'main');
  });

  it('does NOT write reviewed ref for LGTM PR reviews', async () => {
    setIncremental(true);
    const logPath = join(tempDir, 'lgtm-pr.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(
      makeReviewJob('rev-pr', logPath, {
        contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 7 }),
      }),
      0
    );

    expect(mocks.setReviewedRef).not.toHaveBeenCalled();
  });

  it('does NOT write reviewed ref for non-LGTM verdicts', async () => {
    setIncremental(true);
    const logPath = join(tempDir, 'needs-attn.log');
    writeFileSync(logPath, 'Findings:\n- Finding ID: x\n  Severity: low\nVerdict: NEEDS ATTENTION\n');

    await markDone(makeReviewJob('rev-na', logPath), 0);

    expect(mocks.setReviewedRef).not.toHaveBeenCalled();
  });
});

describe('review completion preserves the git index', () => {
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

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-review-index-'));
    mocks.resolveProjectPath.mockReturnValue('/path/to/proj');
    mocks.getSettings.mockReturnValue({
      fix_ci_max_retries: 0,
      fix_ci_retry_window_seconds: 120,
      fix_ci_fast_crash_ms: 5000,
      incremental_review_enabled: false,
      review_retry_on_parse_failure: false,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not stage files after a successful standalone review', async () => {
    const logPath = join(tempDir, 'standalone.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(makeReviewJob('review-standalone', logPath), 0);

    expect(mocks.markReviewed).toHaveBeenCalledWith('proj', '/path/to/proj');
    expect(mocks.exec.mock.calls.some((call: unknown[]) => call[0] === 'git' && (call[1] as string[])[2] === 'add')).toBe(false);
  });

  it('does not stage files after a successful PR review', async () => {
    const logPath = join(tempDir, 'pr-review.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(
      makeReviewJob('review-pr', logPath, {
        contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 7 }),
      }),
      0
    );

    expect(mocks.markReviewed).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.some((call: unknown[]) => call[0] === 'git' && (call[1] as string[])[2] === 'add')).toBe(false);
  });
});

// ─── auto-mark seen on completion ────────────────────────────────────────────

describe('auto-mark seen on completion', () => {
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

  beforeEach(async () => {
    await resetTestState();
  });

  async function runMarkDone(job: JobData, exitCode: number): Promise<boolean> {
    await markDone(job, exitCode);
    const row = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id))).at(0);
    return !!row?.seen;
  }

  it('auto-marks a successful pipeline child seen (commit / push / test)', async () => {
    for (const kind of ['commit', 'push', 'test', 'mark-dod']) {
      // Each iteration starts from a clean state so previous DB rows don't
      // leak into subsequent assertions.
      await resetTestState();
      const seen = await runMarkDone(makeInMemoryJob(`${kind}-ok`, kind), 0);
      expect(seen, `${kind} exit-0 should be auto-seen`).toBe(true);
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

    await resetTestState();
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

    await resetTestState();
    const seenActionable = await runMarkDone(
      makeInMemoryJob('agent-act', 'agent:improve', { modifiedFiles: '[{"path":"a.ts"}]' }),
      0,
    );
    expect(seenActionable).toBe(false);
  });

  it('keeps an agent run unseen when report extraction fails and modifiedFiles is missing', async () => {
    mocks.finalizeAgentRunReport.mockRejectedValueOnce(new Error('git status failed'));
    const seen = await runMarkDone(
      makeInMemoryJob('agent-report-fail', 'agent:improve', { modifiedFiles: null }),
      0,
    );
    expect(seen).toBe(false);
  });
});

// Skipped: push-fix cap is now in iteration-caps.ts (special-case for
// fix-from-push) and exercised in iteration-caps.test.ts.
describe.skip('push fix cap notifications', () => {
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
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-push-fix-cap-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
      autoPrMergeEnabled: false,
    });
    mocks.isHookRejection.mockReturnValue(true);
    mocks.isTestFailureRejection.mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits fix_loop_exhausted when push hook retries hit the cap (counts fix jobs whose parent is a push)', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release.log');
    const pushLog = join(tempDir, 'push.log');
    writeFileSync(releaseLog, '# release start\n');
    writeFileSync(pushLog, 'husky - pre-push hook exited with code 1\n');

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-push-fix-cap',
        project: 'proj',
        kind: 'release',
        logPath: releaseLog,
        startedAt: now - 300,
      }),
      // Two prior failed pushes; each has a fix-from-push that counts toward the cap.
      makeJobRow({
        id: 'push-old-1',
        project: 'proj',
        kind: 'push',
        startedAt: now - 200,
        finishedAt: now - 190,
        exitCode: 1,
      }),
      makeJobRow({
        id: 'fix-old-1',
        project: 'proj',
        kind: 'fix',
        parentJobId: 'push-old-1',
        startedAt: now - 120,
        finishedAt: now - 110,
        exitCode: 0,
      }),
      makeJobRow({
        id: 'push-old-2',
        project: 'proj',
        kind: 'push',
        startedAt: now - 100,
        finishedAt: now - 95,
        exitCode: 1,
      }),
      makeJobRow({
        id: 'fix-old-2',
        project: 'proj',
        kind: 'fix',
        parentJobId: 'push-old-2',
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const pushJob = makePushJob('push-cap-hit', {
      logPath: pushLog,
      releaseId: 'release-push-fix-cap',
      startedAt: now - 10,
    });

    await markDone(pushJob, 1);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      event: 'fix_loop_exhausted',
      project: 'proj',
      job_id: 'push-cap-hit',
      status: 'failed',
    }));

    const releaseRow = (await getTestDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, 'release-push-fix-cap'))).at(0);
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.contextMeta).toContain('"releaseStopReason":"push fix cap reached for proj');
    expect(readFileSync(releaseLog, 'utf8')).toContain('push fix cap reached for proj');
  });
});

// ─── agent drain hook ─────────────────────────────────────────────────────────

describe('agent drain hook', () => {
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

  beforeEach(async () => {
    await resetTestState();
  });

  it('calls drainNextAgentRun with the project when an agent job finishes', async () => {
    const job = makeAgentJob('agent-done', 'agent:improve');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.drainNextAgentRun).toHaveBeenCalledOnce();
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj');
  });

  it('calls drainNextAgentRun even when the agent job fails', async () => {
    const job = makeAgentJob('agent-fail-drain', 'agent:tests');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 1);

    expect(mocks.drainNextAgentRun).toHaveBeenCalledOnce();
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj');
  });

  it('does NOT call drainNextAgentRun for non-agent jobs', async () => {
    const job = makeAgentJob('push-done', 'push');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.drainNextAgentRun).not.toHaveBeenCalled();
  });
});

// ─── agent run failure notification ──────────────────────────────────────────

describe('agent run failure notification', () => {
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

  beforeEach(async () => {
    await resetTestState();
  });

  it('emits agent_run_fail notification when an agent job exits non-zero', async () => {
    const job = makeAgentJob('agent-fail', 'agent:my-agent');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 1);

    const call = mocks.notify.mock.calls.find(
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
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    const failCall = mocks.notify.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(failCall).toBeUndefined();
  });

  it('does NOT emit agent_run_fail for non-agent job failures', async () => {
    const job = makeAgentJob('test-fail', 'test');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 1);

    const failCall = mocks.notify.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(failCall).toBeUndefined();
  });
});

// ─── orphan release lock release ─────────────────────────────────────────────

describe('orphan release lock release', () => {
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

  beforeEach(async () => {
    await resetTestState();
  });

  it('calls releaseLock with project and jobId when a release job completes', async () => {
    const job = makeReleaseJob('release-orphan');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.releaseLock).toHaveBeenCalledWith('proj', 'release-orphan');
  });

  it('does NOT call releaseLock for interactive run jobs', async () => {
    const job = makeReleaseJob('run-job-1', { kind: 'run' });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    // Neither the pipeline-step path nor the release-kind guard applies to `run` jobs
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});

// ─── push → dod target selection ─────────────────────────────────────────────

describe('push → dod target selection', () => {
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
    await resetTestState();
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: false, autoCommitEnabled: false,
      releaseAfterRun: false, prWorkflowEnabled: false,
      autoPrMergeEnabled: false,
    });
  });

  it('uses issue target when ghIssueNumber and ghIssueRepo are set', async () => {
    const job = makePushJob('push-issue-dod', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.startMarkDod).toHaveBeenCalledWith('proj', { issueNumber: 7, repo: 'owner/repo' });
  });

  it('falls back to PR target when ghIssueNumber is null', async () => {
    const job = makePushJob('push-pr-dod', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: null,
      ghIssueRepo: null,
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.startMarkDod).toHaveBeenCalledWith('proj', { prNumber: 42, repo: 'owner/repo' });
  });

  it('skips dod entirely when contextMeta has no prNumber', async () => {
    const job = makePushJob('push-no-meta-dod', {
      exitCode: 0,
      contextMeta: JSON.stringify({ message: 'pushed ok' }),
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.startMarkDod).not.toHaveBeenCalled();
  });

  it('launches pr-wait and skips dod when autoPrMergeEnabled is true', async () => {
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: false, autoCommitEnabled: false,
      releaseAfterRun: false, prWorkflowEnabled: false,
      autoPrMergeEnabled: true,
    });

    const job = makePushJob('push-auto-merge', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.launchPrWait).toHaveBeenCalledWith('proj', 42, 'owner/repo', 'https://github.com/owner/repo/pull/42');
    expect(mocks.startMarkDod).not.toHaveBeenCalled();
  });
});

describe('workflow-driven release short-circuit', () => {
  beforeEach(async () => {
    await resetTestState();
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({ review_fix_max_iterations: 3 });
  });

  it('skips startProjectReview when the release is workflow-driven (test → review chain)', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-workflow-driven';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: releaseId,
        project: 'proj',
        kind: 'release',
        startedAt: now - 60,
        // The legacy `workflowDriven: true` contextMeta stamp was retired;
        // the lifecycle short-circuit now gates on `releaseId` directly.
        contextMeta: null,
      }),
    ]);
    const testJob: JobData = {
      id: 'test-1', project: 'proj', kind: 'test', pid: 99999, logPath: null, prompt: null,
      startedAt: now - 30, finishedAt: null, exitCode: null, seen: false, durationMs: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null,
      sessionId: null, releaseId,
    } as JobData;
    await markDone(testJob, 0);
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
  });

  // Note: the previous "workflowDriven flag" test family was removed when
  // the lifecycle short-circuit moved to gating on `releaseId` directly
  // (see lib/jobs/lifecycle.ts ~line 496). The release-linked job above
  // is short-circuited regardless of any contextMeta marker.

  it('does not affect jobs outside a release (no releaseId)', async () => {
    const now = Date.now() / 1000;
    // Standalone agent run — no releaseId — should never hit the workflow-driven guard.
    const agentJob: JobData = {
      id: 'agent-x', project: 'proj', kind: 'agent:tests', pid: 99999, logPath: null, prompt: null,
      startedAt: now - 30, finishedAt: null, exitCode: null, seen: false, durationMs: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null,
      sessionId: null, releaseId: null,
    } as JobData;
    await markDone(agentJob, 0);
    // Just asserts no crash. Agent runs don't trigger the chain anyway.
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
  });
});
