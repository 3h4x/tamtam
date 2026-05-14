import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDb, createTestPgDbEmpty, type TestDbHandle } from './test-db';
import * as schema from '@/lib/db/schema';

describe('test-db helper', () => {
  // Two tests need a migrated DB; share the same handle to avoid paying
  // ~500ms PGlite boot + migration twice.
  let fullDb: TestDbHandle;

  beforeAll(async () => {
    fullDb = await createTestPgDb();
  });

  afterAll(async () => {
    await fullDb[Symbol.asyncDispose]();
  });

  it('createTestPgDb applies full schema and creates the vector extension', async () => {
    const tables = await fullDb.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const names = (tables.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(names).toContain('settings');
    expect(names).toContain('agents');
    expect(names).toContain('retrieval_chunks');
    const ext = await fullDb.db.execute(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(ext.rows).toHaveLength(1);
  });

  it('createTestPgDbEmpty boots a Postgres with no public tables', async () => {
    const handle = await createTestPgDbEmpty();
    try {
      const tables = await handle.db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public'`,
      );
      expect(tables.rows).toHaveLength(0);
    } finally {
      await handle[Symbol.asyncDispose]();
    }
  });

  it('round-trips a row through drizzle', async () => {
    await fullDb.db.insert(schema.settings).values({ key: 'roundtrip-k', value: 'v' });
    const rows = await fullDb.db
      .select()
      .from(schema.settings)
      .where(sql`${schema.settings.key} = 'roundtrip-k'`);
    expect(rows).toEqual([{ key: 'roundtrip-k', value: 'v' }]);
  });
});
