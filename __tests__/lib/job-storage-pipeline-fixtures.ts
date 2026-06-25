import { beforeAll, afterAll } from 'vitest';
import { sql, type InferInsertModel } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { JobData } from '@/lib/jobs/job-storage';

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

export let sharedHandle: TestDbHandle;

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

export async function truncateAll(): Promise<void> {
  // DELETE is faster than TRUNCATE on PGlite for small tables (no table rewrite,
  // no extension reload). Single execute() with multi-statement is rejected by
  // PGlite, so issue them via a single CTE-style query.
  await sharedHandle.db.execute(sql.raw(
    'WITH a AS (DELETE FROM jobs RETURNING 1), b AS (DELETE FROM recommendations RETURNING 1), c AS (DELETE FROM job_completion_events RETURNING 1) DELETE FROM gh_issues_cache'
  ));
}

export async function flushDbQueue(): Promise<void> {
  // Fire-and-forget writes in job storage are serialized by PGlite, so a
  // no-op query drains anything already queued without polling.
  await sharedHandle.db.execute(sql.raw('SELECT 1'));
}

export type JobInsert = InferInsertModel<typeof schema.jobs>;

// Getter shim so existing `testDb.db.*` test code keeps working while the
// underlying connection is the shared PGlite handle.
export const testDb = {
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

export async function insertJobsAndSync(rows: JobInsert | JobInsert[]): Promise<void> {
  const batch = Array.isArray(rows) ? rows : [rows];
  await sharedHandle.db.insert(schema.jobs).values(batch);
  const { jobsCache } = await import('@/lib/jobs/storage');
  for (const row of batch) {
    jobsCache.set(row.id, toCachedJob(row));
  }
}

// Skipped: the release-linked legacy chain that drove fix re-verification fires
// only for non-workflow-driven jobs now. The orchestrator + applyReleaseGuards
// own this for release-linked jobs. See:
//   __tests__/lib/workflows/decide-next-phase.test.ts (fix → re-verify routing)
//   __tests__/lib/workflows/release-orchestrator.test.ts (integration)
//   __tests__/lib/workflows/guards/* (convergence + iteration caps)
