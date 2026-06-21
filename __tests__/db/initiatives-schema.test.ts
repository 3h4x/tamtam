import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty } from '@/__tests__/helpers/test-db';
import { schema } from '@/lib/db';

async function applyDdl(handle: Awaited<ReturnType<typeof createTestPgDbEmpty>>): Promise<void> {
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

describe('initiatives schema', () => {
  it('inserts and reads back an initiative row with defaults', async () => {
    const handle = await createTestPgDbEmpty();
    try {
      await applyDdl(handle);
      const now = Date.now();
      await handle.db.insert(schema.initiatives).values({
        project: 'proj', source: 'mining', kind: 'lint',
        title: 'Fix lint errors', rationale: 'eslint reported 3 errors',
        prompt: 'Fix all eslint errors in the project.', dedupKey: 'lint:global',
        createdAt: now, updatedAt: now,
      });
      const rows = await handle.db.select().from(schema.initiatives);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('proposed');
      expect(rows[0].score).toBe(0);
      expect(rows[0].attempts).toBe(0);
    } finally {
      await handle[Symbol.asyncDispose]();
    }
  });

  it('enforces unique (project, dedup_key)', async () => {
    const handle = await createTestPgDbEmpty();
    try {
      await applyDdl(handle);
      const now = Date.now();
      const row = {
        project: 'proj', source: 'mining' as const, kind: 'lint',
        title: 't', rationale: 'r', prompt: 'p', dedupKey: 'lint:global',
        createdAt: now, updatedAt: now,
      };
      await handle.db.insert(schema.initiatives).values(row);
      await expect(handle.db.insert(schema.initiatives).values(row)).rejects.toThrow();
    } finally {
      await handle[Symbol.asyncDispose]();
    }
  });
});
