import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

let sharedHandle: TestDbHandle;

async function applyDdl(handle: TestDbHandle): Promise<void> {
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
}

describe('GET /api/agents/stats', () => {
  let GET: typeof import('@/app/api/agents/stats/route').GET;
  const baseJob = {
    pid: 0,
    seen: false,
    logPruned: false,
  };

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
    // The route caches per project on globalThis (survives resetModules); both
    // aggregation tests query project=alpha, so clear it or the second reads the
    // first's cached stats instead of the freshly-seeded rows.
    delete (globalThis as Record<string, unknown>).__tamtamAgentStatsCache;
    delete (globalThis as Record<string, unknown>).__tamtamAgentStatsInflight;
    await sharedHandle.db.execute(sql.raw('TRUNCATE jobs'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/app/api/agents/stats/route');
    GET = mod.GET;
  });

  it('returns 400 when project is missing', async () => {
    const req = new NextRequest('http://localhost/api/agents/stats');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('aggregates duration, tokens, cost, and files per agent name', async () => {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.jobs).values([
      {
        ...baseJob,
        id: 'j1', project: 'alpha', kind: 'agent:cto',
        startedAt: now - 100, finishedAt: now - 90, durationMs: 10000, exitCode: 0,
        inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreateTokens: 0,
        costUsd: 0.05, modifiedFiles: JSON.stringify(['a.ts', 'b.ts']),
      },
      {
        ...baseJob,
        id: 'j2', project: 'alpha', kind: 'agent:cto',
        startedAt: now - 50, finishedAt: now - 30, durationMs: 20000, exitCode: 0,
        inputTokens: 500, outputTokens: 100, cacheReadTokens: 8000, cacheCreateTokens: 0,
        costUsd: 0.03, modifiedFiles: JSON.stringify(['c.ts']),
      },
      {
        ...baseJob,
        id: 'j3', project: 'alpha', kind: 'agent:tests',
        startedAt: now - 20, finishedAt: now - 10, durationMs: 7000, exitCode: 1,
        inputTokens: 300, outputTokens: 50,
        modifiedFiles: null, costUsd: null,
      },
      {
        ...baseJob,
        id: 'j-other-project', project: 'beta', kind: 'agent:cto',
        startedAt: now - 100, finishedAt: now - 90, durationMs: 99999,
        inputTokens: 9999,
      },
    ]);

    const req = new NextRequest('http://localhost/api/agents/stats?project=alpha');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBe('alpha');
    const cto = data.agents.find((a: any) => a.name === 'cto');
    expect(cto).toBeDefined();
    expect(cto.runs).toBe(2);
    expect(cto.finishedRuns).toBe(2);
    expect(cto.successfulRuns).toBe(2);
    expect(cto.avgDurationMs).toBe(15000);
    expect(cto.totalDurationMs).toBe(30000);
    expect(cto.inputTokens).toBe(1500);
    expect(cto.outputTokens).toBe(300);
    expect(cto.cacheReadTokens).toBe(13000);
    expect(cto.costUsd).toBeCloseTo(0.08, 4);
    expect(cto.modifiedFilesCount).toBe(3);
    expect(cto.reviewFixesTriggered).toBe(0);

    const tests = data.agents.find((a: any) => a.name === 'tests');
    expect(tests.runs).toBe(1);
    expect(tests.successfulRuns).toBe(0);
    expect(tests.modifiedFilesCount).toBe(0);
  });

  it('counts fix-loop iterations for review-style agents via shared release_id', async () => {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.jobs).values([
      {
        ...baseJob,
        id: 'rev-1', project: 'alpha', kind: 'agent:review-watch',
        startedAt: now - 100, finishedAt: now - 90, durationMs: 5000, exitCode: 0,
        releaseId: 'rel-1',
      },
      {
        ...baseJob,
        id: 'fix-1', project: 'alpha', kind: 'fix',
        startedAt: now - 88, finishedAt: now - 80, releaseId: 'rel-1',
      },
      {
        ...baseJob,
        id: 'fix-2', project: 'alpha', kind: 'fix',
        startedAt: now - 78, finishedAt: now - 70, releaseId: 'rel-1',
      },
      {
        ...baseJob,
        id: 'fix-other', project: 'alpha', kind: 'fix',
        startedAt: now - 78, finishedAt: now - 70, releaseId: 'unrelated',
      },
    ]);

    const req = new NextRequest('http://localhost/api/agents/stats?project=alpha');
    const res = await GET(req);
    const data = await res.json();
    const review = data.agents.find((a: any) => a.name === 'review-watch');
    expect(review).toBeDefined();
    expect(review.reviewFixesTriggered).toBe(2);
  });

  it('serves a repeat request within TTL from cache (rows changed after the first call are not seen until the cache is stale)', async () => {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.jobs).values([
      { ...baseJob, id: 'c1', project: 'gamma', kind: 'agent:cto', startedAt: now - 10, finishedAt: now - 5, exitCode: 0 },
    ]);
    const first = await GET(new NextRequest('http://localhost/api/agents/stats?project=gamma'));
    expect((await first.json()).agents.find((a: any) => a.name === 'cto').runs).toBe(1);

    // Insert another run; a cached read within TTL still reports the old count.
    await sharedHandle.db.insert(schema.jobs).values([
      { ...baseJob, id: 'c2', project: 'gamma', kind: 'agent:cto', startedAt: now - 4, finishedAt: now - 1, exitCode: 0 },
    ]);
    const second = await GET(new NextRequest('http://localhost/api/agents/stats?project=gamma'));
    expect((await second.json()).agents.find((a: any) => a.name === 'cto').runs).toBe(1);
  });
});
