import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

let sharedHandle: TestDbHandle;

vi.mock('@/lib/db', () => ({
  get db() {
    return sharedHandle.db;
  },
  get schema() {
    return schema;
  },
}));

import {
  attachJobToDurableAgentRunSlot,
  clearDurableAgentRunSlot,
  releaseDurableAgentRunSlotForJob,
  tryClaimDurableAgentRunSlot,
} from '@/lib/agents/durable-agent-run-slot';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS maintenance_status (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
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
}

async function insertJob(id: string, project = 'p1', finishedAt: number | null = null): Promise<void> {
  await sharedHandle.db.execute(sql.raw(`
    INSERT INTO jobs (id, project, kind, pid, started_at, finished_at)
    VALUES ('${id}', '${project}', 'agent:holder', 12345, 1, ${finishedAt === null ? 'NULL' : finishedAt})
  `));
}

describe('durable-agent-run-slot', () => {
  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await applyDdl(sharedHandle);
    await sharedHandle.db.execute(sql.raw('WITH a AS (DELETE FROM maintenance_status RETURNING 1) DELETE FROM jobs'));
    vi.useRealTimers();
  });

  it('lets one claimant win atomically per project', async () => {
    const [a, b] = await Promise.all([
      tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a1', agentName: 'test-e2e' }),
      tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a2', agentName: 'docs' }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false });
  });

  it('blocks later claims while the attached job is still active', async () => {
    const claim = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a1', agentName: 'test-e2e' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await insertJob('job-1');
    expect(await attachJobToDurableAgentRunSlot('p1', claim.token, 'job-1')).toBe(true);

    const next = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a2', agentName: 'docs' });
    expect(next).toEqual({
      ok: false,
      runningAgent: 'test-e2e',
      agentId: 'a1',
      jobId: 'job-1',
    });
  });

  it('releases the slot when the owning job finishes', async () => {
    const claim = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a1', agentName: 'test-e2e' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await insertJob('job-1', 'p1');
    await attachJobToDurableAgentRunSlot('p1', claim.token, 'job-1');
    await releaseDurableAgentRunSlotForJob({ project: 'p1', id: 'job-1' });

    const next = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a2', agentName: 'docs' });
    expect(next.ok).toBe(true);
  });

  it('clears completed attached slots on the next claim', async () => {
    const claim = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a1', agentName: 'test-e2e' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await insertJob('job-1', 'p1', 10);
    await attachJobToDurableAgentRunSlot('p1', claim.token, 'job-1');

    const next = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a2', agentName: 'docs' });
    expect(next.ok).toBe(true);
  });

  it('ages out unattached slots left by a crash before job creation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    const claim = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a1', agentName: 'test-e2e' });
    expect(claim.ok).toBe(true);

    vi.setSystemTime(new Date('2026-06-02T12:06:00Z'));
    const next = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a2', agentName: 'docs' });
    expect(next.ok).toBe(true);
  });

  it('does not release a slot owned by a different job', async () => {
    const claim = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a1', agentName: 'test-e2e' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await insertJob('job-1', 'p1');
    await attachJobToDurableAgentRunSlot('p1', claim.token, 'job-1');
    await releaseDurableAgentRunSlotForJob({ project: 'p1', id: 'other-job' });

    const next = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a2', agentName: 'docs' });
    expect(next).toMatchObject({ ok: false, jobId: 'job-1' });
    await clearDurableAgentRunSlot('p1');
  });
});
