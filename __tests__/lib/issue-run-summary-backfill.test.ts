import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      prompt text,
      pid integer NOT NULL DEFAULT 0,
      log_path text,
      started_at double precision NOT NULL DEFAULT 0,
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
      prompt_bytes integer,
      work_summary text,
      modified_files text,
      provider text
    )
  `));
}

describe('issue-run-summary-backfill', () => {
  let sharedHandle: TestDbHandle;
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let listIssueRunSummaryBackfillCandidates: typeof import('@/lib/agents/issue-run-summary-backfill').listIssueRunSummaryBackfillCandidates;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE jobs'));
    vi.doMock('@/lib/db', () => ({
      db: sharedHandle.db,
      schema,
    }));
    ({ listIssueRunSummaryBackfillCandidates } = await import(
      '@/lib/agents/issue-run-summary-backfill'
    ));
  });

  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns only finished issue-linked runs whose summary is still missing', async () => {
    await handle.db.execute(sql.raw(`
      INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary) VALUES
        ('issue-null', 'proj', 'run', 1001, 1, '/logs/issue-null.ndjson', 2, 42, NULL),
        ('issue-empty', 'proj', 'run', 1002, 1, '/logs/issue-empty.ndjson', 2, 43, ''),
        ('issue-filled', 'proj', 'run', 1003, 1, '/logs/issue-filled.ndjson', 2, 44, 'Already summarized'),
        ('issue-no-log', 'proj', 'run', 1004, 1, NULL, 2, 45, NULL),
        ('issue-running', 'proj', 'run', 1005, 1, '/logs/issue-running.ndjson', NULL, 46, NULL),
        ('non-issue-run', 'proj', 'run', 1006, 1, '/logs/non-issue.ndjson', 2, NULL, NULL),
        ('agent-run', 'proj', 'agent:tests', 1007, 1, '/logs/agent.ndjson', 2, 47, NULL)
    `));

    expect(await listIssueRunSummaryBackfillCandidates()).toEqual([
      { id: 'issue-null', logPath: '/logs/issue-null.ndjson' },
      { id: 'issue-empty', logPath: '/logs/issue-empty.ndjson' },
    ]);
  });

  it('does not treat agent rows or ordinary terminal runs as backfill targets', async () => {
    await handle.db.execute(sql.raw(`
      INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary) VALUES
        ('agent-null', 'proj', 'agent:docs', 1001, 1, '/logs/agent-null.ndjson', 2, NULL, NULL),
        ('run-non-issue', 'proj', 'run', 1002, 1, '/logs/run-non-issue.ndjson', 2, NULL, NULL),
        ('issue-filled', 'proj', 'run', 1003, 1, '/logs/issue-filled.ndjson', 2, 9, 'done')
    `));

    expect(await listIssueRunSummaryBackfillCandidates()).toEqual([]);
  });
});
