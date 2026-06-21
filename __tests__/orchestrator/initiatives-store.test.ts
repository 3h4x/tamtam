import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';
import type { InitiativeStatus } from '@/lib/orchestrator/initiatives-store';

const base = {
  project: 'proj', source: 'mining' as const, kind: 'lint',
  title: 'Fix lint', rationale: '3 errors', prompt: 'fix lint', dedupKey: 'lint:global',
};

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

describe('initiatives-store', () => {
  let sharedHandle: TestDbHandle;
  let store: typeof import('@/lib/orchestrator/initiatives-store');

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
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('upserts a new candidate as proposed', async () => {
    const row = await store.upsertCandidate(base, 1000);
    expect(row.status).toBe('proposed');
    expect(row.id).toBeGreaterThan(0);
  });

  it('upsert refreshes a proposed row without duplicating', async () => {
    await store.upsertCandidate(base, 1000);
    const again = await store.upsertCandidate({ ...base, title: 'Fix lint (5)', score: 9 }, 2000);
    expect(again.title).toBe('Fix lint (5)');
    const all = await store.listByStatus('proj', 'proposed');
    expect(all).toHaveLength(1);
  });

  it('does not resurrect a shipped row on re-detection', async () => {
    const row = await store.upsertCandidate(base, 1000);
    await store.setStatus(row.id, 'shipped', undefined, 1500);
    await store.upsertCandidate({ ...base, title: 'changed' }, 2000);
    expect(await store.listByStatus('proj', 'proposed')).toHaveLength(0);
    expect(await store.listByStatus('proj', 'shipped')).toHaveLength(1);
  });

  it('listQueued respects cooldown and orders by score desc', async () => {
    const a = await store.upsertCandidate({ ...base, dedupKey: 'a', score: 1 }, 1000);
    const b = await store.upsertCandidate({ ...base, dedupKey: 'b', score: 5 }, 1000);
    const c = await store.upsertCandidate({ ...base, dedupKey: 'c', score: 9 }, 1000);
    await store.setStatus(a.id, 'queued', undefined, 1000);
    await store.setStatus(b.id, 'queued', undefined, 1000);
    await store.setStatus(c.id, 'queued', { cooldownUntil: 9999 }, 1000);
    const q = await store.listQueued('proj', 5000);
    expect(q.map((r) => r.dedupKey)).toEqual(['b', 'a']); // c is in cooldown
  });

  it('countByStatusAllProjects returns all statuses zero-defaulted when table is empty', async () => {
    const counts = await store.countByStatusAllProjects();
    const keys: string[] = ['proposed', 'queued', 'running', 'shipped', 'failed', 'rejected', 'superseded'];
    for (const k of keys) {
      expect(counts[k as InitiativeStatus]).toBe(0);
    }
  });

  it('countByStatusAllProjects groups rows across projects by status', async () => {
    const a = await store.upsertCandidate({ ...base, project: 'alpha', dedupKey: 'a1' }, 1000);
    const b = await store.upsertCandidate({ ...base, project: 'alpha', dedupKey: 'a2' }, 1000);
    const c = await store.upsertCandidate({ ...base, project: 'beta', dedupKey: 'b1' }, 1000);
    await store.setStatus(b.id, 'shipped', undefined, 2000);
    await store.setStatus(c.id, 'failed', undefined, 2000);
    const counts = await store.countByStatusAllProjects();
    expect(counts.proposed).toBe(1); // a
    expect(counts.shipped).toBe(1);  // b
    expect(counts.failed).toBe(1);   // c
    expect(counts.queued).toBe(0);
  });

  it('countShippedTodayAllProjects counts only shipped rows updated on or after start of day', async () => {
    // Use a fixed "now" of 1_700_000_000_000 ms (2023-11-14T22:13:20Z)
    // start-of-day = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000 = 1_699_920_000_000
    const nowMs = 1_700_000_000_000;
    const startOfDay = Math.floor(nowMs / 86_400_000) * 86_400_000; // 1_699_920_000_000

    const yesterday = await store.upsertCandidate({ ...base, dedupKey: 'yest' }, startOfDay - 1);
    await store.setStatus(yesterday.id, 'shipped', undefined, startOfDay - 1);

    const today = await store.upsertCandidate({ ...base, dedupKey: 'tod' }, startOfDay + 1000);
    await store.setStatus(today.id, 'shipped', undefined, startOfDay + 1000);

    const proposed = await store.upsertCandidate({ ...base, dedupKey: 'prop' }, startOfDay + 2000);
    // proposed stays proposed — not counted

    const n = await store.countShippedTodayAllProjects(nowMs);
    expect(n).toBe(1);
    expect(proposed.status).toBe('proposed');
  });

  it('listRecentInitiatives returns rows ordered updatedAt desc and respects limit', async () => {
    const a = await store.upsertCandidate({ ...base, dedupKey: 'r1' }, 1000);
    const b = await store.upsertCandidate({ ...base, dedupKey: 'r2' }, 2000);
    const c = await store.upsertCandidate({ ...base, dedupKey: 'r3' }, 3000);
    // bump a's updatedAt to be newest
    await store.setStatus(a.id, 'queued', undefined, 9000);

    const rows = await store.listRecentInitiatives(2);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(a.id);   // updated most recently (9000)
    expect(rows[1].id).toBe(c.id);   // second newest (3000)
  });

  it('listAllInitiatives returns all rows ordered updatedAt desc and respects limit', async () => {
    const a = await store.upsertCandidate({ ...base, dedupKey: 'all1' }, 1000);
    const b = await store.upsertCandidate({ ...base, dedupKey: 'all2' }, 2000);
    const c = await store.upsertCandidate({ ...base, dedupKey: 'all3' }, 3000);
    // bump a's updatedAt to be newest
    await store.setStatus(a.id, 'queued', undefined, 9000);

    const all = await store.listAllInitiatives(10);
    expect(all).toHaveLength(3);
    expect(all[0].id).toBe(a.id);   // updated most recently (9000)
    expect(all[1].id).toBe(c.id);   // second newest (3000)
    expect(all[2].id).toBe(b.id);   // oldest (2000)

    // limit is respected
    const limited = await store.listAllInitiatives(2);
    expect(limited).toHaveLength(2);
    expect(limited[0].id).toBe(a.id);
    expect(limited[1].id).toBe(c.id);

    // full row shape is returned (not slim)
    const row = all[0];
    expect(typeof row.prompt).toBe('string');
    expect(typeof row.attempts).toBe('number');
    expect(row.dedupKey).toBe('all1');
  });

  it('defaults pinnedAt to null on a freshly upserted candidate', async () => {
    const row = await store.upsertCandidate({ ...base, dedupKey: 'pin-default' }, 1000);
    expect(row.pinnedAt).toBeNull();
  });

  it('setPinned sets and clears pinned_at; getInitiativeById reflects it', async () => {
    const r = await store.upsertCandidate({ ...base, dedupKey: 'pin-toggle' }, 1000);
    await store.setPinned(r.id, 123456);
    expect((await store.getInitiativeById(r.id))?.pinnedAt).toBe(123456);
    await store.setPinned(r.id, null);
    expect((await store.getInitiativeById(r.id))?.pinnedAt).toBeNull();
  });

  it('getInitiativeById returns null for a missing id', async () => {
    expect(await store.getInitiativeById(999999)).toBeNull();
  });

  it('listQueued returns pinned rows before higher-score unpinned rows', async () => {
    const a = await store.upsertCandidate({ ...base, dedupKey: 'q-a', score: 10 }, 1000);
    const b = await store.upsertCandidate({ ...base, dedupKey: 'q-b', score: 90 }, 1000);
    await store.setStatus(a.id, 'queued');
    await store.setStatus(b.id, 'queued');
    await store.setPinned(a.id, 1);
    const queued = await store.listQueued('proj');
    expect(queued[0].id).toBe(a.id); // pinned leads despite lower score
  });

  it('relinks a running initiative from agent job id to release job id', async () => {
    const row = await store.upsertCandidate({ ...base, dedupKey: 'relink' }, 1000);
    await store.setStatus(row.id, 'running', { releaseId: 'agent-job-1' }, 2000);

    await store.linkRunningInitiativeToRelease('agent-job-1', 'release-job-1', 3000);

    const linked = await store.getInitiativeById(row.id);
    expect(linked?.status).toBe('running');
    expect(linked?.releaseId).toBe('release-job-1');
    expect(linked?.updatedAt).toBe(3000);
  });
});
