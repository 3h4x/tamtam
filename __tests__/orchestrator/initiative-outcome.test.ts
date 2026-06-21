import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

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
  await handle.db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "initiatives_project_dedup_key"
      ON "initiatives" ("project", "dedup_key")
  `));
}

describe('initiative-outcome', () => {
  let sharedHandle: TestDbHandle;
  let store: typeof import('@/lib/orchestrator/initiatives-store');
  let outcome: typeof import('@/lib/orchestrator/initiative-outcome');

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE initiatives RESTART IDENTITY'));
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    store = await import('@/lib/orchestrator/initiatives-store');
    outcome = await import('@/lib/orchestrator/initiative-outcome');
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('counts ships today and excludes yesterday', async () => {
    const day = 24 * 3600 * 1000;
    const today = 10 * day + 5 * 3600 * 1000; // mid-day
    const a = await store.upsertCandidate(
      { project: 'p', source: 'mining', kind: 'lint', title: 't', rationale: 'r', prompt: 'p', dedupKey: 'a' }, today);
    const b = await store.upsertCandidate(
      { project: 'p', source: 'mining', kind: 'lint', title: 't', rationale: 'r', prompt: 'p', dedupKey: 'b' }, today);
    await outcome.markInitiativeOutcome(a.id, 'shipped', 'rel-1', today);
    await outcome.markInitiativeOutcome(b.id, 'shipped', 'rel-2', today - day); // yesterday
    expect(await outcome.shipsTodayCount('p', today)).toBe(1);
  });

  it('failed sets a cooldown', async () => {
    const row = await store.upsertCandidate(
      { project: 'p', source: 'mining', kind: 'lint', title: 't', rationale: 'r', prompt: 'p', dedupKey: 'a' }, 1000);
    await outcome.markInitiativeOutcome(row.id, 'failed', null, 1000);
    const failed = (await store.listByStatus('p', 'failed'))[0];
    expect(failed.cooldownUntil).toBe(1000 + 6 * 3600 * 1000);
  });
});
