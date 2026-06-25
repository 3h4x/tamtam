import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function applyJobsSchema(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS jobs (
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
  )`));
  await handle.db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS gh_issues_cache (
    project text PRIMARY KEY,
    repo text NOT NULL,
    prs text NOT NULL DEFAULT '[]',
    issues text NOT NULL DEFAULT '[]',
    fetched_at double precision NOT NULL
  )`));
  await handle.db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS job_completion_events (
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
  )`));
}

describe('GitHub board sync failures are non-fatal', () => {
  let sharedHandle: TestDbHandle;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyJobsSchema(sharedHandle);
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
    await sharedHandle.db.execute(sql.raw('TRUNCATE jobs, gh_issues_cache, job_completion_events'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('still creates a job when the start sync fails', async () => {
    vi.doMock('@/lib/github/project-board', () => ({
      queueJobBoardSync: vi.fn().mockRejectedValue(new Error('boom')),
    }));

    const { createJob, getJob } = await import('@/lib/jobs/job-storage');
    const job = createJob('proj', 'run', 99999, '/tmp/log');
    await Promise.resolve();

    expect(getJob(job.id)?.id).toBe(job.id);
  });

  it('still completes a job when the finish sync fails', async () => {
    vi.doMock('@/lib/github/project-board', () => ({
      queueJobBoardSync: vi.fn().mockRejectedValue(new Error('boom')),
    }));
    vi.doMock('@/lib/jobs/retention', () => ({
      pruneProjectLogs: vi.fn(),
    }));
    // markDone on a kind:'run' job with exitCode 0 normally triggers
    // the release-after-run pipeline, which spawns real PM2 subprocesses
    // and leaks kernel resources. Mock the chain so this test exercises
    // only the board-sync hook.
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: () => ({ releaseAfterRun: false }),
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }),
    }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'mocked' }),
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: vi.fn(),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      runAutoChainGates: () => null,
    }));

    const { createJob, markDone, getJob } = await import('@/lib/jobs/job-storage');
    const job = createJob('proj', 'run', 99999, '/tmp/log');
    await markDone(job, 0);

    expect(getJob(job.id)?.finishedAt).not.toBeNull();
    expect(getJob(job.id)?.exitCode).toBe(0);
  });
});
