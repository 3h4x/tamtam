import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL DEFAULT 0,
      log_path TEXT,
      started_at REAL NOT NULL DEFAULT 0,
      finished_at REAL,
      exit_code INTEGER,
      seen INTEGER DEFAULT 0,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_create_tokens INTEGER,
      session_id TEXT,
      user_prompt TEXT,
      context_meta TEXT,
      parent_job_id TEXT,
      gh_issue_number INTEGER,
      gh_issue_repo TEXT,
      gh_issue_title TEXT,
      log_pruned INTEGER DEFAULT 0,
      verdict TEXT,
      cost_usd REAL,
      model TEXT,
      release_id TEXT,
      aborted_at REAL,
      prompt_bytes INTEGER,
      work_summary TEXT,
      modified_files TEXT,
      provider TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('GET /api/agents/stats', () => {
  let GET: any;
  let testDb: ReturnType<typeof createTestDb>;
  const baseJob = {
    pid: 0,
    seen: false,
    logPruned: false,
  };

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/app/api/agents/stats/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 400 when project is missing', async () => {
    const req = new NextRequest('http://localhost/api/agents/stats');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('aggregates duration, tokens, cost, and files per agent name', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.jobs).values([
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
    ]).run();

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
    testDb.db.insert(schema.jobs).values([
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
    ]).run();

    const req = new NextRequest('http://localhost/api/agents/stats?project=alpha');
    const res = await GET(req);
    const data = await res.json();
    const review = data.agents.find((a: any) => a.name === 'review-watch');
    expect(review).toBeDefined();
    expect(review.reviewFixesTriggered).toBe(2);
  });
});
