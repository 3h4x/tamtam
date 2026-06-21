import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
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

describe('admitProject', () => {
  let sharedHandle: TestDbHandle;
  let admitProject: typeof import('@/lib/orchestrator/initiative-admit').admitProject;
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
    ({ admitProject } = await import('@/lib/orchestrator/initiative-admit'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('upserts findings and promotes up to the backlog cap', async () => {
    await admitProject('proj', {
      project: 'proj',
      findings: [
        { kind: 'lint', title: 'a', rationale: 'r', prompt: 'p', dedupKey: 'a' },
        { kind: 'todo', title: 'b', rationale: 'r', prompt: 'p', dedupKey: 'b' },
        { kind: 'todo', title: 'c', rationale: 'r', prompt: 'p', dedupKey: 'c' },
      ],
    }, 2, 1000);
    expect(await store.listByStatus('proj', 'queued')).toHaveLength(2);
    expect(await store.listByStatus('proj', 'proposed')).toHaveLength(1);
  });

  it('respects existing queued count when computing room', async () => {
    // Pre-seed one queued row so the cap of 2 only admits 1 more proposed
    await store.upsertCandidate(
      { project: 'proj', source: 'mining', kind: 'lint', title: 'pre', rationale: 'r', prompt: 'p', dedupKey: 'pre' },
      500,
    );
    await store.setStatus(1, 'queued', undefined, 500);

    await admitProject('proj', {
      project: 'proj',
      findings: [
        { kind: 'todo', title: 'x', rationale: 'r', prompt: 'p', dedupKey: 'x' },
        { kind: 'todo', title: 'y', rationale: 'r', prompt: 'p', dedupKey: 'y' },
      ],
    }, 2, 1000);

    expect(await store.listByStatus('proj', 'queued')).toHaveLength(2);
    expect(await store.listByStatus('proj', 'proposed')).toHaveLength(1);
  });

  it('does nothing when the backlog is already full', async () => {
    await admitProject('proj', {
      project: 'proj',
      findings: [
        { kind: 'lint', title: 'a', rationale: 'r', prompt: 'p', dedupKey: 'a' },
        { kind: 'todo', title: 'b', rationale: 'r', prompt: 'p', dedupKey: 'b' },
      ],
    }, 0, 1000);
    // cap=0: everything stays proposed (upserted but none promoted)
    expect(await store.listByStatus('proj', 'queued')).toHaveLength(0);
  });
});
