import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "initiatives" (
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
}

async function seedRow(handle: TestDbHandle, overrides: Partial<typeof schema.initiatives.$inferInsert> = {}): Promise<number> {
  const inserted = await handle.db.insert(schema.initiatives).values({
    project: 'p', source: 'mining', kind: 'lint', title: 't', rationale: 'r', prompt: 'pr',
    score: 50, status: 'queued', dedupKey: 'd', createdAt: 0, updatedAt: 0,
    ...overrides,
  }).returning({ id: schema.initiatives.id });
  return inserted[0].id;
}

describe('PATCH /api/initiatives/[id]', () => {
  let handle: TestDbHandle;
  let PATCH: typeof import('@/app/api/initiatives/[id]/route').PATCH;

  beforeAll(async () => {
    handle = await createTestPgDbEmpty();
    await applyDdl(handle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try { await handle[Symbol.asyncDispose](); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await handle.db.execute(sql.raw('TRUNCATE initiatives RESTART IDENTITY'));
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
    ({ PATCH } = await import('@/app/api/initiatives/[id]/route'));
  });

  afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  function call(id: string, body: unknown) {
    return PATCH(
      new NextRequest('http://localhost/api/initiatives/' + id, { method: 'PATCH', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    );
  }

  async function readRow(id: number) {
    const rows = await handle.db.execute(sql.raw(`SELECT status, pinned_at, release_id, cooldown_until FROM initiatives WHERE id = ${id}`));
    return rows.rows[0] as {
      status: string;
      pinned_at: number | null;
      release_id: string | null;
      cooldown_until: number | null;
    };
  }

  it('promote sets pinned_at', async () => {
    const id = await seedRow(handle);
    const res = await call(String(id), { action: 'promote' });
    expect(res.status).toBe(200);
    expect((await readRow(id)).pinned_at).not.toBeNull();
  });

  it('unpromote clears pinned_at', async () => {
    const id = await seedRow(handle);
    await call(String(id), { action: 'promote' });
    await call(String(id), { action: 'unpromote' });
    expect((await readRow(id)).pinned_at).toBeNull();
  });

  it('reject sets status rejected; restore returns to queued and clears pin', async () => {
    const id = await seedRow(handle);
    await call(String(id), { action: 'promote' });
    expect((await call(String(id), { action: 'reject' })).status).toBe(200);
    expect((await readRow(id)).status).toBe('rejected');
    await call(String(id), { action: 'restore' });
    const row = await readRow(id);
    expect(row.status).toBe('queued');
    expect(row.pinned_at).toBeNull();
  });

  it('restore clears stale release and cooldown state from a rejected initiative', async () => {
    const id = await seedRow(handle, {
      status: 'rejected',
      pinnedAt: 123,
      releaseId: 'old-release',
      cooldownUntil: 456,
      dedupKey: 'restore-stale',
    });

    expect((await call(String(id), { action: 'restore' })).status).toBe(200);

    const row = await readRow(id);
    expect(row.status).toBe('queued');
    expect(row.pinned_at).toBeNull();
    expect(row.release_id).toBeNull();
    expect(row.cooldown_until).toBeNull();
  });

  it.each(['running', 'shipped', 'failed', 'superseded'] as const)(
    'rejects curation actions for %s initiatives',
    async (status) => {
      const id = await seedRow(handle, {
        status,
        releaseId: `${status}-release`,
        dedupKey: `status-${status}`,
      });

      expect((await call(String(id), { action: 'reject' })).status).toBe(409);
      expect((await call(String(id), { action: 'promote' })).status).toBe(409);

      const row = await readRow(id);
      expect(row.status).toBe(status);
      expect(row.release_id).toBe(`${status}-release`);
    },
  );

  it('rejects restore unless the initiative is rejected', async () => {
    const id = await seedRow(handle);
    expect((await call(String(id), { action: 'restore' })).status).toBe(409);
    expect((await readRow(id)).status).toBe('queued');
  });

  it('unknown action → 400', async () => {
    const id = await seedRow(handle);
    expect((await call(String(id), { action: 'nope' })).status).toBe(400);
  });

  it('missing id → 404', async () => {
    expect((await call('999999', { action: 'promote' })).status).toBe(404);
  });
});
