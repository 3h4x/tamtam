import { beforeAll, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
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
      lines_added integer,
      lines_removed integer,
      provider text,
      run_score integer,
      skill_ids text NOT NULL DEFAULT '[]'
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
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      enabled boolean DEFAULT false,
      github text,
      priority text,
      custom_actions text,
      test_command text,
      tests_disabled boolean DEFAULT false,
      review_disabled boolean DEFAULT false,
      test_cron_enabled boolean DEFAULT false,
      test_cron_schedule text,
      auto_commit_enabled boolean DEFAULT false,
      auto_push_enabled boolean DEFAULT false,
      auto_pr_merge_enabled boolean DEFAULT false,
      post_merge_watch_minutes integer DEFAULT 0,
      auto_revert_enabled boolean DEFAULT false,
      release_after_run boolean DEFAULT false,
      issue_auto_branch boolean DEFAULT true,
      last_push_error text,
      last_push_at double precision,
      review_prompt_addendum text,
      review_prerequisite_command text,
      fix_prompt_addendum text,
      website text,
      qa_url text,
      dev_server_start_command text,
      dev_server_stop_command text,
      dev_server_ready_url text,
      daily_spend_cap_usd double precision,
      release_spend_cap_usd double precision,
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
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
  await handle.db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS job_completion_events_unconsumed
    ON job_completion_events (consumed_by, emitted_at)
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
  isRemoteRaceRejection: vi.fn(),
  // pipeline/review-exhaustion-fallback
  fileReviewExhaustionIssue: vi.fn(),
  // pipeline/start-commit
  startProjectCommit: vi.fn(),
  // pipeline/start-review
  startProjectReview: vi.fn(),
  // pipeline/start-test
  startProjectTest: vi.fn(),
  hasRunnableTestCommand: vi.fn(),
  isReviewRetestJob: vi.fn(),
  // pipeline/start-mark-dod
  startMarkDod: vi.fn(),
  // pipeline/start-pr-wait
  launchPrWait: vi.fn(),
  // pipeline/pr-review-merge
  maybeAutoMergeAfterPrReview: vi.fn(),
  // jobs/verdict-retry
  retryVerdictWithClaude: vi.fn(),
  // agents/agent-run-report
  finalizeAgentRunReport: vi.fn(),
  // agents/pending-agent-run
  drainNextAgentRun: vi.fn(),
  // dev-server lifecycle
  hasActiveWorkForProject: vi.fn(),
  stopDevServer: vi.fn(),
}));

export { mocks };

// Module-level mocks; the factories late-bind to the hoisted bag, so the
// stable `mocks.*` fn refs survive `vi.resetAllMocks()` and per-describe
// reconfiguration via `mockReset().mockResolvedValue(...)`.
vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.db.current;
  },
  schema,
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
  isRemoteRaceRejection: mocks.isRemoteRaceRejection,
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
  hasRunnableTestCommand: mocks.hasRunnableTestCommand,
  isReviewRetestJob: mocks.isReviewRetestJob,
}));
vi.mock('@/lib/pipeline/start-mark-dod', () => ({
  startMarkDod: mocks.startMarkDod,
}));
vi.mock('@/lib/pipeline/start-pr-wait', () => ({
  launchPrWait: mocks.launchPrWait,
}));
vi.mock('@/lib/pipeline/pr-review-merge', () => ({
  maybeAutoMergeAfterPrReview: mocks.maybeAutoMergeAfterPrReview,
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
vi.mock('@/lib/dev-server/active-work', () => ({
  hasActiveWorkForProject: mocks.hasActiveWorkForProject,
}));
vi.mock('@/lib/dev-server/lifecycle', () => ({
  stopDevServer: mocks.stopDevServer,
}));

// Late-bound module bindings. Imported once in `beforeAll` AFTER the test DB
// is initialized so `vi.mock('@/lib/db')`'s factory returns a real Drizzle
// handle. The `import` happens once for the whole file (vs 61 times in the
// previous implementation), saving ~50-100ms per test.
export let markDone: typeof import('@/lib/jobs/job-storage').markDone;
export let runCompletionHooks: typeof import('@/lib/jobs/job-storage').runCompletionHooks;
export let finalizeReleaseJob: typeof import('@/lib/jobs/lifecycle').finalizeReleaseJob;
export let finalizeAbortedRelease: typeof import('@/lib/jobs/lifecycle').finalizeAbortedRelease;
export let jobsCache: Map<string, JobData>;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
  mocks.db.current = sharedHandle.db;
  const mod = await import('@/lib/jobs/job-storage');
  markDone = mod.markDone;
  runCompletionHooks = mod.runCompletionHooks;
  const lifecycle = await import('@/lib/jobs/lifecycle');
  finalizeReleaseJob = lifecycle.finalizeReleaseJob;
  finalizeAbortedRelease = lifecycle.finalizeAbortedRelease;
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
  mocks.isRemoteRaceRejection.mockReturnValue(false);
  mocks.fileReviewExhaustionIssue.mockResolvedValue({ ok: true, issueNumber: 7, issueUrl: 'https://github.com/owner/repo/issues/7' });
  mocks.startProjectCommit.mockResolvedValue({ ok: true, commitSha: 'abc123', message: 'commit ok', jobId: 'commit-auto' });
  mocks.startProjectReview.mockResolvedValue({ ok: true, jobId: 'review-next' });
  mocks.startProjectTest.mockResolvedValue({ ok: true, jobId: 'test-next' });
  mocks.hasRunnableTestCommand.mockResolvedValue(true);
  mocks.isReviewRetestJob.mockReturnValue(false);
  mocks.startMarkDod.mockResolvedValue({ ok: true, verified: 1, total: 1, changed: false });
  mocks.launchPrWait.mockReturnValue({ jobId: 'pr-wait-job' });
  mocks.maybeAutoMergeAfterPrReview.mockResolvedValue({ launched: false, reason: 'auto-merge-disabled' });
  mocks.retryVerdictWithClaude.mockResolvedValue(null);
  mocks.finalizeAgentRunReport.mockResolvedValue(undefined);
  mocks.drainNextAgentRun.mockResolvedValue(undefined);
  mocks.hasActiveWorkForProject.mockResolvedValue(false);
  mocks.stopDevServer.mockResolvedValue({ status: 'stopped', pid: 1234 });
}

export async function resetTestState(): Promise<void> {
  jobsCache.clear();
  // Single TRUNCATE — fast on small tables, single round-trip to PGlite.
  await sharedHandle.db.execute(
    sql.raw('TRUNCATE jobs, recommendations, gh_issues_cache, settings, projects, job_completion_events'),
  );
  applyDefaultMocks();
}

export function makeJobRow<T extends Record<string, unknown>>(overrides: T) {
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
export function populateJobCache(rows: ReadonlyArray<Record<string, unknown>>): void {
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
      releaseDeadlineAt: (r.releaseDeadlineAt as number | null | undefined) ?? null,
      promptBytes: (r.promptBytes as number | null | undefined) ?? null,
      workSummary: (r.workSummary as string | null | undefined) ?? null,
      modifiedFiles: (r.modifiedFiles as string | null | undefined) ?? null,
      linesAdded: (r.linesAdded as number | null | undefined) ?? null,
      linesRemoved: (r.linesRemoved as number | null | undefined) ?? null,
      provider: (r.provider as string | null | undefined) ?? null,
      runScore: (r.runScore as number | null | undefined) ?? null,
    });
  }
}

// Insert one or more rows into the DB AND populate the jobsCache mirror.
export async function insertJobsAndCache(
  db: TestDbHandle['db'],
  rows: ReadonlyArray<Record<string, unknown>>,
) {
  if (rows.length === 0) return;
  await db.insert(schema.jobs).values(rows as never);
  populateJobCache(rows);
}

export function ndjsonText(text: string): string {
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
export function getTestDb(): TestDbHandle['db'] {
  return sharedHandle.db;
}

export async function insertProjectWithDevServer(project = 'proj'): Promise<void> {
  await getTestDb().insert(schema.projects).values({
    name: project,
    path: `/workspace/${project}`,
    devServerStartCommand: 'pnpm dev',
    devServerStopCommand: 'pnpm dev:stop',
    devServerReadyUrl: 'http://localhost:3000',
  });
}
