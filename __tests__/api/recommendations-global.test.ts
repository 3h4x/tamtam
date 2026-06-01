import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
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
}

describe('GET /api/recommendations', () => {
  let sharedHandle: TestDbHandle;
  let GET: typeof import('@/app/api/recommendations/route').GET;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try { await sharedHandle[Symbol.asyncDispose](); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE recommendations'));
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    ({ GET } = await import('@/app/api/recommendations/route'));

    const row = (id: string, status: string, updatedAt: number) => ({
      id, project: 'alpha', sourceKind: 'agent:x', type: 'agent_unfruitful',
      title: id, detail: 'd', status, createdAt: 1, updatedAt,
    });
    await sharedHandle.db.insert(schema.recommendations).values([
      row('open-1', 'open', 50),
      row('resolved-1', 'resolved', 70),
      row('dismissed-1', 'dismissed', 60),
      row('applied-1', 'applied', 80),
    ]);
  });

  it('returns only open recommendations by default (Unresolved tab)', async () => {
    const res = await GET(new NextRequest('http://localhost/api/recommendations'));
    const body = await res.json();
    expect(body.recommendations.map((r: { id: string }) => r.id)).toEqual(['open-1']);
  });

  it('returns non-open recommendations newest-first with ?state=history', async () => {
    const res = await GET(new NextRequest('http://localhost/api/recommendations?state=history'));
    const body = await res.json();
    expect(body.recommendations.map((r: { id: string }) => r.id)).toEqual(['applied-1', 'resolved-1', 'dismissed-1']);
    expect(body.recommendations.map((r: { status: string }) => r.status)).toEqual(['applied', 'resolved', 'dismissed']);
  });
});
