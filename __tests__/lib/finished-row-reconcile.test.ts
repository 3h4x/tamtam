import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import type { JobData } from '@/lib/jobs/job-storage';

let sharedHandle: TestDbHandle;

vi.mock('@/lib/db', () => ({
  get db() {
    return sharedHandle.db;
  },
  get schema() {
    return schema;
  },
}));

import { reconcileFinishedDbRows } from '@/lib/jobs/finished-row-reconcile';
import { jobsCache } from '@/lib/jobs/storage';
import { tryClaimDurableAgentRunSlot, attachJobToDurableAgentRunSlot } from '@/lib/agents/durable-agent-run-slot';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS maintenance_status (
      key text PRIMARY KEY, value text NOT NULL, updated_at double precision NOT NULL
    )`));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY, project text NOT NULL, kind text NOT NULL, prompt text,
      pid integer NOT NULL, log_path text, started_at double precision NOT NULL,
      finished_at double precision, exit_code integer, seen boolean DEFAULT false,
      duration_ms integer, aborted_at double precision
    )`));
}

async function insertOpenJob(id: string, project = 'p1'): Promise<void> {
  await sharedHandle.db.execute(sql.raw(`
    INSERT INTO jobs (id, project, kind, pid, started_at, finished_at)
    VALUES ('${id}', '${project}', 'agent:qa', 0, 1, NULL)`));
}

function cacheJob(id: string, project: string, finishedAt: number | null): JobData {
  return {
    id, project, kind: 'agent:qa', prompt: null, pid: 0, logPath: null,
    startedAt: 1, finishedAt, exitCode: finishedAt == null ? null : -1,
    seen: false, contextMeta: null, userPrompt: null, parentJobId: null,
    ghIssueNumber: null, ghIssueRepo: null, ghIssueTitle: null, releaseId: null,
    abortedAt: finishedAt,
  } as JobData;
}

async function dbFinishedAt(id: string): Promise<number | null> {
  const rows = await sharedHandle.db.execute(sql.raw(`SELECT finished_at FROM jobs WHERE id='${id}'`));
  // PGlite returns { rows: [...] }
  const r = (rows as unknown as { rows: Array<{ finished_at: number | null }> }).rows[0];
  return r?.finished_at ?? null;
}

describe('reconcileFinishedDbRows', () => {
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
    jobsCache.clear();
  });

  it('re-persists a finalize whose DB write was lost, and frees its durable slot', async () => {
    await insertOpenJob('job-1');
    // Cache already considers it done (markDone ran) but the DB write was dropped.
    jobsCache.set('job-1', cacheJob('job-1', 'p1', 1000));
    // The zombie is pinning the project's durable agent-run slot.
    const claim = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a1', agentName: 'qa' });
    expect(claim.ok).toBe(true);
    if (claim.ok) await attachJobToDurableAgentRunSlot('p1', claim.token, 'job-1');

    const fixed = await reconcileFinishedDbRows();

    expect(fixed).toBe(1);
    expect(await dbFinishedAt('job-1')).toBe(1000);
    // Slot freed → a new claim succeeds (no 409 deadlock).
    const next = await tryClaimDurableAgentRunSlot({ project: 'p1', agentId: 'a2', agentName: 'qa' });
    expect(next.ok).toBe(true);
  });

  it('leaves genuinely-running jobs (cache also open) untouched', async () => {
    await insertOpenJob('job-2');
    jobsCache.set('job-2', cacheJob('job-2', 'p1', null)); // cache also open

    const fixed = await reconcileFinishedDbRows();

    expect(fixed).toBe(0);
    expect(await dbFinishedAt('job-2')).toBeNull();
  });
});
