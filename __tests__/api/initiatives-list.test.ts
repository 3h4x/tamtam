import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS initiatives (
      "id" serial PRIMARY KEY NOT NULL,
      "project" text NOT NULL,
      "source" text NOT NULL,
      "kind" text NOT NULL,
      "title" text NOT NULL,
      "rationale" text NOT NULL,
      "prompt" text NOT NULL,
      "score" double precision DEFAULT 0 NOT NULL,
      "status" text DEFAULT 'proposed' NOT NULL,
      "dedup_key" text NOT NULL,
      "release_id" text,
      "attempts" integer DEFAULT 0 NOT NULL,
      "cooldown_until" double precision,
      "pinned_at" double precision,
      "created_at" double precision NOT NULL,
      "updated_at" double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "initiatives_project_dedup_key"
      ON "initiatives" ("project", "dedup_key")
  `));
}

describe('GET /api/initiatives', () => {
  let sharedHandle: TestDbHandle;
  let GET: typeof import('@/app/api/initiatives/route').GET;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try { await sharedHandle[Symbol.asyncDispose](); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE initiatives RESTART IDENTITY'));
    await sharedHandle.db.execute(sql.raw('TRUNCATE settings'));

    await sharedHandle.db.insert(schema.settings).values([
      { key: 'initiative_engine_enabled', value: 'true' },
      { key: 'initiative_mining_enabled', value: 'true' },
      { key: 'initiative_max_ships_per_day', value: '3' },
      { key: 'initiative_max_backlog_per_project', value: '50' },
    ]);

    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        initiative_engine_enabled: true,
        initiative_mining_enabled: true,
        initiative_max_ships_per_day: 3,
        initiative_max_backlog_per_project: 50,
      }),
      initSettings: vi.fn().mockResolvedValue(undefined),
    }));

    ({ GET } = await import('@/app/api/initiatives/route'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns 200 with expected shape when table is empty', async () => {
    const res = await GET(new NextRequest('http://localhost/api/initiatives'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.generatedAt).toBe('number');
    expect(body.flags.engineEnabled).toBe(true);
    expect(body.flags.miningEnabled).toBe(true);
    expect(body.flags.maxShipsPerDay).toBe(3);
    expect(body.flags.maxBacklogPerProject).toBe(50);
    const statuses = ['proposed', 'queued', 'running', 'shipped', 'failed', 'rejected', 'superseded'];
    for (const s of statuses) {
      expect(body.counts[s]).toBe(0);
    }
    expect(body.initiatives).toEqual([]);
  });

  it('counts initiatives by status correctly', async () => {
    const nowMs = Date.now();
    await sharedHandle.db.insert(schema.initiatives).values([
      { project: 'alpha', source: 'mining', kind: 'lint', title: 'T1', rationale: 'r', prompt: 'p', dedupKey: 'k1', status: 'proposed', createdAt: nowMs, updatedAt: nowMs },
      { project: 'alpha', source: 'mining', kind: 'lint', title: 'T2', rationale: 'r', prompt: 'p', dedupKey: 'k2', status: 'shipped', createdAt: nowMs, updatedAt: nowMs },
      { project: 'beta', source: 'pm', kind: 'feat', title: 'T3', rationale: 'r', prompt: 'p', dedupKey: 'k3', status: 'failed', createdAt: nowMs, updatedAt: nowMs },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/initiatives'));
    const body = await res.json();
    expect(body.counts.proposed).toBe(1);
    expect(body.counts.shipped).toBe(1);
    expect(body.counts.failed).toBe(1);
    expect(body.counts.queued).toBe(0);
  });

  it('returns initiatives ordered by updatedAt desc', async () => {
    const nowMs = Date.now();
    await sharedHandle.db.insert(schema.initiatives).values([
      { project: 'p1', source: 'mining', kind: 'lint', title: 'Older', rationale: 'r', prompt: 'p', dedupKey: 'old', status: 'proposed', createdAt: nowMs - 2000, updatedAt: nowMs - 2000 },
      { project: 'p1', source: 'pm', kind: 'feat', title: 'Newer', rationale: 'r', prompt: 'p', dedupKey: 'new', status: 'queued', createdAt: nowMs - 1000, updatedAt: nowMs - 1000 },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/initiatives'));
    const body = await res.json();
    expect(body.initiatives).toHaveLength(2);
    expect(body.initiatives[0].title).toBe('Newer');
    expect(body.initiatives[1].title).toBe('Older');
  });

  it('slim shape omits prompt, attempts, cooldownUntil, dedupKey, createdAt', async () => {
    const nowMs = Date.now();
    await sharedHandle.db.insert(schema.initiatives).values([
      { project: 'x', source: 'mining', kind: 'lint', title: 'T', rationale: 'reason', prompt: 'do it', dedupKey: 'dk', status: 'proposed', score: 7.5, createdAt: nowMs, updatedAt: nowMs },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/initiatives'));
    const body = await res.json();
    const row = body.initiatives[0];
    expect(typeof row.id).toBe('number');
    expect(row.project).toBe('x');
    expect(row.source).toBe('mining');
    expect(row.kind).toBe('lint');
    expect(row.title).toBe('T');
    expect(row.rationale).toBe('reason');
    expect(row.score).toBe(7.5);
    expect(row.status).toBe('proposed');
    expect(row.releaseId).toBeNull();
    expect(row).toHaveProperty('pinnedAt');
    expect(row.pinnedAt).toBeNull();
    expect(typeof row.updatedAt).toBe('number');
    // omitted fields
    expect(row.prompt).toBeUndefined();
    expect(row.attempts).toBeUndefined();
    expect(row.cooldownUntil).toBeUndefined();
    expect(row.dedupKey).toBeUndefined();
    expect(row.createdAt).toBeUndefined();
  });
});
