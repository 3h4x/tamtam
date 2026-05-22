import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { createTestPgDb, type TestDbHandle } from '../helpers/test-db';

describe('GET /api/projects/by-project/[projectName]/prompt-insights', () => {
  let handle: TestDbHandle;
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/prompt-insights/route').GET;

  beforeAll(async () => {
    handle = await createTestPgDb();
  });

  afterAll(async () => {
    await handle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await handle.db.execute(sql.raw('TRUNCATE jobs'));
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/prompt-insights/route');
    GET = mod.GET;
  });

  function makeJob(overrides: Partial<typeof schema.jobs.$inferInsert>) {
    return {
      id: `job-${Math.random().toString(36).slice(2)}`,
      project: 'demo',
      kind: 'agent:test',
      pid: 0,
      startedAt: Math.floor(Date.now() / 1000) - 60,
      finishedAt: Math.floor(Date.now() / 1000),
      exitCode: 0,
      ...overrides,
    } as typeof schema.jobs.$inferInsert;
  }

  it('rejects out-of-range days param', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/demo/prompt-insights?days=999');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'demo' }) });
    expect(res.status).toBe(400);
  });

  it('returns empty-shaped result when no agent jobs exist', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/demo/prompt-insights');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'demo' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agentJobCount).toBe(0);
    expect(data.promptBytes).toBeNull();
    expect(data.retrieval.sampled).toBe(0);
    expect(data.memory.sampled).toBe(0);
  });

  it('aggregates retrieval + memory + prompt size from agent jobs only', async () => {
    await handle.db.insert(schema.jobs).values([
      makeJob({
        kind: 'agent:improve',
        promptBytes: 10_000,
        contextMeta: JSON.stringify({
          composition: { memory: { state: 'present', truncated: false, rawChars: 3600 }, hasPrereq: false },
          retrieval: { status: 'ok', reason: 'results', acceptedCount: 3, topScore: 0.82, scoreThreshold: 0.75, retrievedCount: 5, corpusChunkCount: 200 },
        }),
      }),
      makeJob({
        kind: 'agent:improve',
        promptBytes: 14_000,
        contextMeta: JSON.stringify({
          composition: { memory: { state: 'present', truncated: true, rawChars: 2400 }, hasPrereq: true },
          retrieval: { status: 'warning', reason: 'below_threshold', acceptedCount: 0, topScore: 0.71, scoreThreshold: 0.75, retrievedCount: 5, corpusChunkCount: 200 },
        }),
      }),
      makeJob({
        // Pipeline phase — must NOT count toward agent insights.
        kind: 'review',
        promptBytes: 50_000,
        contextMeta: JSON.stringify({ composition: { memory: { state: 'present', truncated: false, rawChars: 1000 } } }),
      }),
    ]);

    const req = new NextRequest('http://localhost/api/projects/by-project/demo/prompt-insights');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'demo' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agentJobCount).toBe(2);
    expect(data.promptBytes.avg).toBe(12_000);
    expect(data.promptBytes.max).toBe(14_000);
    expect(data.retrieval.sampled).toBe(2);
    expect(data.retrieval.attached).toBe(1);
    expect(data.retrieval.attachRate).toBeCloseTo(0.5, 3);
    expect(data.retrieval.reasons).toEqual({ results: 1, below_threshold: 1 });
    expect(data.memory.truncatedCount).toBe(1);
    expect(data.memory.truncationRate).toBeCloseTo(0.5, 3);
    expect(data.memory.maxRawChars).toBe(3600);
    expect(data.prereq.withPrereq).toBe(1);
    expect(data.prereq.withoutPrereq).toBe(1);
  });

  it('drops legacy jobs without structured contextMeta from aggregates', async () => {
    await handle.db.insert(schema.jobs).values([
      makeJob({ kind: 'agent:legacy', promptBytes: 5_000, contextMeta: null }),
      makeJob({ kind: 'agent:legacy', promptBytes: 5_000, contextMeta: '{invalid json' }),
    ]);
    const req = new NextRequest('http://localhost/api/projects/by-project/demo/prompt-insights');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'demo' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agentJobCount).toBe(2);
    expect(data.promptBytes?.avg).toBe(5_000);
    expect(data.retrieval.sampled).toBe(0);
    expect(data.memory.sampled).toBe(0);
  });
});
